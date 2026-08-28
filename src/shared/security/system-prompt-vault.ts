import { createCipheriv, createHash, randomBytes, timingSafeEqual } from 'crypto';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { LRUCache } from 'lru-cache';
import { logger } from '../logger';
import { errorMessage } from '../errors';
import { decryptionDuration, encryptionDuration, measureDuration } from './guardrail-metrics';
import { KeyManager, type IKeyManager } from './key-manager';
import { ENCRYPTION_ALGORITHM, IV_LENGTH, FALLBACK_PROMPT } from './vault-constants';
import { decryptWithKeyRing } from './vault-decrypt';

export class SystemPromptVault {
  private readonly keyManager: IKeyManager;
  private readonly securitySalt: string;
  private readonly cache: LRUCache<string, string>;
  private readonly cacheTTL: number;
  private healthy: boolean = true;

  constructor(config: {
    masterSecret: string;
    securitySalt?: string;
    cacheMaxSize?: number;
    cacheTTL?: number;
    keyManager?: IKeyManager;
  }) {
    this.keyManager = config.keyManager || new KeyManager(config.masterSecret);
    this.securitySalt = config.securitySalt || randomBytes(32).toString('hex');
    this.cacheTTL = config.cacheTTL || 300000;

    this.cache = new LRUCache<string, string>({
      max: config.cacheMaxSize || 100,
      ttl: this.cacheTTL,
      updateAgeOnGet: true,
    });

    logger.info('SystemPromptVault initialized', {
      keyVersion: this.keyManager.getActiveVersion(),
      cacheMaxSize: this.cache.max,
      cacheTTL: this.cacheTTL,
    });
  }

  getPrompt(sessionId: string, encryptedPrompt: string): string {
    const tracer = trace.getTracer('system-prompt-vault');
    const span = tracer.startSpan('get-system-prompt');

    try {
      if (!this.healthy) {
        span.setAttribute('vault.degraded', true);
        logger.error('SECURITY HEADER DEGRADED — vault unhealthy, serving fallback prompt', {
          sessionId,
        });
        return FALLBACK_PROMPT;
      }

      const cacheKey = this.getCacheKey(sessionId, encryptedPrompt);
      const cached = this.cache.get(cacheKey);

      if (cached) {
        span.setAttribute('cache.hit', true);
        return this.injectSessionMarkers(cached, sessionId);
      }

      span.setAttribute('cache.hit', false);

      const decrypted = measureDuration(decryptionDuration, () => this.decrypt(encryptedPrompt));

      this.cache.set(cacheKey, decrypted);

      span.setStatus({ code: SpanStatusCode.OK });

      return this.injectSessionMarkers(decrypted, sessionId);
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: errorMessage(error),
      });

      logger.error('Failed to retrieve system prompt, degrading gracefully', {
        error,
        sessionId,
      });

      this.healthy = false;

      const restore = setTimeout(() => {
        this.healthy = true;
        logger.info('Vault health restored');
      }, 60000);
      restore.unref?.();

      span.setAttribute('vault.degraded', true);

      return FALLBACK_PROMPT;
    } finally {
      span.end();
    }
  }

  encrypt(plaintext: string): { encrypted: string; version: number } {
    return measureDuration(encryptionDuration, () => {
      const key = this.keyManager.getEncryptionKey();
      const iv = randomBytes(IV_LENGTH);

      const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);

      let encrypted = cipher.update(plaintext, 'utf8');
      encrypted = Buffer.concat([encrypted, cipher.final()]);

      const authTag = cipher.getAuthTag();
      const version = this.keyManager.getActiveVersion();
      const versionBuffer = Buffer.alloc(4);
      versionBuffer.writeUInt32BE(version, 0);

      const result = Buffer.concat([versionBuffer, iv, encrypted, authTag]);

      return {
        encrypted: result.toString('base64'),
        version,
      };
    });
  }

  verifyIntegrity(prompt: string, expectedHmac: string): boolean {
    const hmac = createHash('sha256').update(this.securitySalt).update(prompt).digest('hex');

    const hmacBuffer = Buffer.from(hmac, 'hex');
    const expectedBuffer = Buffer.from(expectedHmac, 'hex');

    if (hmacBuffer.length !== expectedBuffer.length) {
      const dummyBuffer = Buffer.alloc(hmacBuffer.length);
      timingSafeEqual(hmacBuffer, dummyBuffer);
      return false;
    }

    return timingSafeEqual(hmacBuffer, expectedBuffer);
  }

  rotateKey(): void {
    this.keyManager.rotate();
    this.cache.clear();
    logger.info('Key rotation completed, cache cleared');
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  private decrypt(encryptedData: string): string {
    return decryptWithKeyRing(
      encryptedData,
      this.keyManager.getDecryptionKeys(),
      this.keyManager.getActiveVersion(),
    );
  }

  private getCacheKey(sessionId: string, encryptedPrompt: string): string {
    return createHash('sha256')
      .update(`${sessionId}:${encryptedPrompt.substring(0, 64)}`)
      .digest('hex');
  }

  private injectSessionMarkers(prompt: string, sessionId: string): string {
    const sessionHash = createHash('sha256')
      .update(sessionId + this.securitySalt)
      .digest('hex')
      .substring(0, 16);

    return prompt.replace('[[SESSION_MARKER]]', `[SECURITY_ID:${sessionHash}]`);
  }
}

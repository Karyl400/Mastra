import { hkdfSync, scryptSync } from 'crypto';

import { logger } from '../logger';
import type { IKeyManager, KeyVersion } from './guardrail-types';

export type { IKeyManager } from './guardrail-types';

export class KeyManager implements IKeyManager {
  private static readonly KEY_ITERATIONS = 16384;
  private static readonly KEY_LENGTH = 32;
  private static readonly SALT = 'kisso-system-prompt-vault-v2';

  private activeKey: KeyVersion;
  private keyHistory: KeyVersion[];
  private masterKey: Buffer;

  constructor(masterSecret: string) {
    this.masterKey = scryptSync(masterSecret, KeyManager.SALT, KeyManager.KEY_LENGTH, {
      N: KeyManager.KEY_ITERATIONS,
    });

    this.keyHistory = [];
    this.activeKey = this.deriveKey(1);
    this.keyHistory.push(this.activeKey);
  }

  rotate(): void {
    const newVersion = this.activeKey.version + 1;
    const retiredKey = { ...this.activeKey };

    this.activeKey = this.deriveKey(newVersion);
    this.keyHistory.push(this.activeKey);

    if (this.keyHistory.length > 3) {
      this.keyHistory = this.keyHistory.slice(-3);
    }

    logger.info('Encryption key rotated', {
      newVersion,
      previousVersion: retiredKey.version,
      keyHistoryLength: this.keyHistory.length,
    });
  }

  getEncryptionKey(): Buffer {
    return this.activeKey.key;
  }

  getActiveVersion(): number {
    return this.activeKey.version;
  }

  getDecryptionKeys(): Buffer[] {
    return [this.activeKey.key, ...this.keyHistory.map((k) => k.key)];
  }

  private deriveKey(version: number): KeyVersion {
    const versionBuffer = Buffer.alloc(4);
    versionBuffer.writeUInt32BE(version, 0);

    const derivedKey = hkdfSync(
      'sha256',
      this.masterKey,
      versionBuffer,
      `kisso-prompt-v${version}`,
      KeyManager.KEY_LENGTH,
    );

    return {
      version,
      key: Buffer.from(derivedKey),
      createdAt: new Date(),
    };
  }
}

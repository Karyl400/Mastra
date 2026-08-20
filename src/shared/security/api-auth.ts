import { createHash, timingSafeEqual } from 'node:crypto';
import type { MastraAuthConfig } from '@mastra/core/server';

export const API_TOKEN_ENV_VAR = 'MASTRA_API_TOKEN';

export const MIN_API_TOKEN_LENGTH = 32;

export interface ApiServiceUser {
  readonly id: string;
  readonly type: 'service';
}

export const API_SERVICE_USER: ApiServiceUser = Object.freeze({
  id: 'service-account',
  type: 'service',
});

export function constantTimeEquals(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

function normalizeToken(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/^Bearer\s+/i, '').trim();
}

export function readConfiguredApiToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[API_TOKEN_ENV_VAR];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < MIN_API_TOKEN_LENGTH) return null;
  return trimmed;
}

export interface VerifyApiTokenOptions {
  expectedToken: string | null;
  presentedToken: string | null | undefined;
}

export function verifyApiToken({ expectedToken, presentedToken }: VerifyApiTokenOptions): boolean {
  if (expectedToken === null || expectedToken.length < MIN_API_TOKEN_LENGTH) {
    return false;
  }

  const presented = normalizeToken(presentedToken);
  if (presented.length === 0) {
    return false;
  }

  return constantTimeEquals(presented, expectedToken);
}

export interface CreateApiAuthConfigOptions {
  env?: NodeJS.ProcessEnv;
  onMisconfigured?: (message: string) => void;
}

export function createApiAuthConfig(
  options: CreateApiAuthConfigOptions = {},
): MastraAuthConfig<ApiServiceUser> {
  const { env = process.env, onMisconfigured } = options;

  let warned = false;
  const warnOnce = () => {
    if (warned) return;
    warned = true;
    onMisconfigured?.(
      `${API_TOKEN_ENV_VAR} absent ou trop court (< ${MIN_API_TOKEN_LENGTH} caractères) : ` +
        'toutes les routes /api/* répondent 401 (fail-closed). ' +
        'Définir la variable dans .env et sur Vercel pour rétablir le service.',
    );
  };

  return {
    authenticateToken: async (token, _request) => {
      const expectedToken = readConfiguredApiToken(env);
      if (expectedToken === null) {
        warnOnce();
      }

      if (!verifyApiToken({ expectedToken, presentedToken: token })) {
        return null as unknown as ApiServiceUser;
      }

      return API_SERVICE_USER;
    },
  };
}

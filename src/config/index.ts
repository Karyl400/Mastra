import { z } from 'zod';
import { logger } from '../shared/logger';

const ConfigSchema = z.object({
  openai: z.object({ apiKey: z.string().min(1) }).strict(),
  database: z.object({
    url: z.string().refine(u => process.env.NODE_ENV === 'production'
      ? u.startsWith('postgresql://') && u.includes('sslmode=require')
      : u.startsWith('file:') || u.startsWith('postgresql://'),
      'Invalid database URL')
  }).strict(),
  notifications: z.object({
    resend: z.object({ apiKey: z.string().min(1) }),
    from: z.string().email(),
    slack: z.object({ botToken: z.string(), signingSecret: z.string() }),
  }).strict(),
  app: z.object({
    logLevel: z.enum(['debug', 'info', 'warn', 'error']),
    nodeEnv: z.enum(['development', 'staging', 'production', 'test']),
  }).strict(),
});

export type Config = z.infer<typeof ConfigSchema>;

let configPromise: Promise<Config> | null = null;

export function getConfig(): Promise<Config> {
  if (configPromise) return configPromise;
  configPromise = loadConfig();
  return configPromise;
}

export function resetConfig(): void {
  configPromise = null;
}

async function loadConfig(): Promise<Config> {
  const raw = process.env.NODE_ENV === 'production'
    ? await loadFromSecretsManager()
    : {
        openai:     { apiKey: process.env.OPENAI_API_KEY ?? '' },
        database:   { url: process.env.DATABASE_URL ?? 'file:./data/kisso.db' },
        notifications: {
          resend: { apiKey: process.env.RESEND_API_KEY ?? '' },
          from:   process.env.NOTIFICATION_FROM ?? 'noreply@kisso.com',
          slack: {
            botToken:      process.env.SLACK_BOT_TOKEN ?? '',
            signingSecret: process.env.SLACK_SIGNING_SECRET ?? '',
          },
        },
        app: {
          logLevel: process.env.LOG_LEVEL ?? 'info',
          nodeEnv:  process.env.NODE_ENV ?? 'development',
        },
      };
  const cfg = ConfigSchema.parse(raw);
  logger.info('Config loaded', { env: cfg.app.nodeEnv });
  return cfg;
}

async function loadFromSecretsManager(): Promise<unknown> {
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({
    requestHandler: { requestTimeout: 5000 },
  });
  const { SecretString } = await client.send(
    new GetSecretValueCommand({ SecretId: process.env.AWS_SECRET_ID || 'kisso/config' })
  );
  try { return JSON.parse(SecretString || '{}'); }
  catch { throw new Error('Secret is not valid JSON'); }
}
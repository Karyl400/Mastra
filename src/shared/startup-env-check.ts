import { API_TOKEN_ENV_VAR, MIN_API_TOKEN_LENGTH } from './security/api-auth';

export interface CriticalEnvVar {
  readonly name: string;
  readonly consequence: string;
  readonly minLength?: number;
}

export const CRITICAL_ENV_VARS: readonly CriticalEnvVar[] = Object.freeze([
  {
    name: 'SLACK_SIGNING_SECRET',
    consequence:
      'toute requête Slack sera rejetée en 401 missing_signature_headers — le bot ne répondra à aucun message.',
  },
  {
    name: 'SLACK_BOT_TOKEN',
    consequence:
      'aucune publication, aucun DM, aucun envoi de fichier : chaque appel Slack échouera en invalid_auth.',
  },
  {
    name: 'GROQ_API_KEY',
    consequence:
      'le modèle primaire est injoignable ; chaque message tombera chez Mistral, plafonné à 4 requêtes par minute.',
  },
  {
    name: 'MISTRAL_API_KEY',
    consequence:
      'aucun repli : la moindre erreur Groq (quota journalier compris) ressortira en HTTP 500.',
  },
  {
    name: API_TOKEN_ENV_VAR,
    consequence: `absent ou plus court que ${MIN_API_TOKEN_LENGTH} caractères, toutes les routes /api/* répondent 401 (fail-closed).`,
    minLength: MIN_API_TOKEN_LENGTH,
  },
] satisfies CriticalEnvVar[]);

export function missingCriticalEnv(
  env: NodeJS.ProcessEnv = process.env,
): readonly CriticalEnvVar[] {
  return CRITICAL_ENV_VARS.filter((entry) => {
    const value = env[entry.name]?.trim() ?? '';
    return value.length < (entry.minLength ?? 1);
  });
}

export interface StartupEnvLogger {
  error(message: string, ...args: unknown[]): void;
}

export function reportMissingCriticalEnv(
  env: NodeJS.ProcessEnv = process.env,
  log: StartupEnvLogger = console,
): readonly CriticalEnvVar[] {
  const missing = missingCriticalEnv(env);

  for (const entry of missing) {
    log.error(`Variable d'environnement critique absente : ${entry.name}`, {
      variable: entry.name,
      conséquence: entry.consequence,
    });
  }

  return missing;
}

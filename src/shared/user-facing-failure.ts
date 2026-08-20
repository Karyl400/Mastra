import { logger } from './logger';
import { securityRefusalMessage } from './security/llm-guardrail';

export const GENERIC_FAILURE =
  'Quelque chose a cassé de mon côté — ça ne vient pas de ta demande. Réessaie, et si ça ' +
  'recommence, remonte-le : je ne peux pas me réparer tout seul.';

export const QUOTA_FAILURE =
  "Je n'ai plus de quota chez mes fournisseurs de modèle. Réessaie dans quelques minutes — " +
  "et si ça persiste, c'est le plafond de la journée qui est atteint : ça repartira demain.";

export const TIMEOUT_FAILURE =
  "Je n'ai pas réussi à répondre dans le temps qui m'est imparti — je n'ai donc rien fait. " +
  'Réessaie : ça passe le plus souvent au coup suivant.';

export function userFacingFailure(error: unknown): string {
  const refusal = securityRefusalMessage(error);
  if (refusal) return refusal;

  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    const candidate = current as {
      name?: unknown;
      statusCode?: unknown;
      status?: unknown;
      cause?: unknown;
    };
    const status = candidate.statusCode ?? candidate.status;
    if (status === 429) return QUOTA_FAILURE;

    if (candidate.name === 'TimeoutError' || candidate.name === 'AbortError') {
      return TIMEOUT_FAILURE;
    }
    if (candidate.name === 'AI_APICallError' || candidate.name === 'APICallError') {
      if (/rate limit|quota/i.test(String((candidate as { message?: unknown }).message ?? ''))) {
        return QUOTA_FAILURE;
      }
    }
    current = candidate.cause;
  }

  logger.warn('Échec non classé — le message générique va être rendu', {
    chain: describeErrorChain(error),
  });

  return GENERIC_FAILURE;
}

function describeErrorChain(error: unknown): Array<Record<string, unknown>> {
  const chain: Array<Record<string, unknown>> = [];
  for (let current: unknown = error, depth = 0; current && depth < 6; depth += 1) {
    const c = current as {
      name?: unknown;
      message?: unknown;
      statusCode?: unknown;
      status?: unknown;
      cause?: unknown;
    };
    chain.push({
      name: String(c.name ?? ''),
      status: c.statusCode ?? c.status ?? null,
      message: String(c.message ?? '').slice(0, 160),
    });
    current = c.cause;
  }
  return chain;
}

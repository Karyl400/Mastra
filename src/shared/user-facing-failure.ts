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

const MAX_ERROR_NODES = 12;

function walkErrorGraph(root: unknown): readonly unknown[] {
  const seen = new Set<unknown>();
  const queue: unknown[] = [root];
  const visited: unknown[] = [];

  while (queue.length > 0 && visited.length < MAX_ERROR_NODES) {
    const current = queue.shift();
    if (current === null || typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);
    visited.push(current);

    const node = current as { cause?: unknown; lastError?: unknown; errors?: unknown };
    queue.push(node.cause, node.lastError);
    if (Array.isArray(node.errors)) queue.push(...node.errors);
  }

  return visited;
}

export function userFacingFailure(error: unknown): string {
  const refusal = securityRefusalMessage(error);
  if (refusal) return refusal;

  for (const node of walkErrorGraph(error)) {
    const candidate = node as {
      name?: unknown;
      statusCode?: unknown;
      status?: unknown;
      message?: unknown;
    };

    const status = candidate.statusCode ?? candidate.status;
    if (status === 429) return QUOTA_FAILURE;

    if (candidate.name === 'TimeoutError' || candidate.name === 'AbortError') {
      return TIMEOUT_FAILURE;
    }
    if (candidate.name === 'AI_APICallError' || candidate.name === 'APICallError') {
      if (/rate limit|quota/i.test(String(candidate.message ?? ''))) {
        return QUOTA_FAILURE;
      }
    }
  }

  logger.warn('Échec non classé — le message générique va être rendu', {
    chain: describeErrorChain(error),
  });

  return GENERIC_FAILURE;
}

export function describeErrorChain(error: unknown): Array<Record<string, unknown>> {
  return walkErrorGraph(error).map((node) => {
    const c = node as {
      name?: unknown;
      message?: unknown;
      statusCode?: unknown;
      status?: unknown;
    };
    return {
      name: String(c.name ?? ''),
      status: c.statusCode ?? c.status ?? null,
      message: String(c.message ?? '').slice(0, 160),
    };
  });
}

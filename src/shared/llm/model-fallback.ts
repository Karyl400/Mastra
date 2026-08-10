import { createGroq } from '@ai-sdk/groq';
import { createMistral } from '@ai-sdk/mistral';
import type { ModelWithRetries } from '@mastra/core/agent';
import { logger as sharedLogger } from '../logger';

/**
 * Chaîne de modèles partagée par les trois agents Mastra.
 *
 * Mastra 1.57 accepte `model: ModelWithRetries[]` sur un `Agent`. Le basculement
 * est assuré par `executeStreamWithFallbackModels`
 * (`@mastra/core/dist/agent-Dj30gJa3.js:23206`) : chaque modèle sauf le dernier est
 * appelé avec `shouldThrowError: true`, donc TOUTE erreur non-`TripWire` — y compris
 * un 429 — remonte et déclenche l'essai du modèle suivant. Le basculement n'est
 * jamais filtré par classe d'erreur.
 *
 * Le dernier modèle, lui, est appelé avec `shouldThrowError: false` : son erreur
 * n'est pas encapsulée, elle est renvoyée telle quelle au client (d'où le
 * `HTTP 500 {"error":"Rate limit exceeded"}` observé — c'est le message brut du
 * DERNIER modèle, pas celui du premier).
 *
 * Deux réglages corrigent ce comportement ici :
 *
 * 1. `maxRetries`. Mastra passe cette valeur à `p-retry`
 *    (`retries: modelSettings?.maxRetries ?? 2`, `agent-Dj30gJa3.js:22122`) et la
 *    normalise à **0** par défaut pour les entrées d'un tableau
 *    (`prepareModels`, `agent-Dj30gJa3.js:34185`). Résultat : le back-off
 *    exponentiel ET la prise en compte de l'en-tête `Retry-After` — tous deux déjà
 *    implémentés par Mastra — sont désactivés. On ne rétablit un budget de reprise
 *    que sur le DERNIER maillon (voir {@link LAST_RESORT_MAX_RETRIES}).
 *
 * 2. Les `id`. Sans `id` explicite, `Agent.toFallbackEntry` en génère un via
 *    `randomUUID()` : les journaux et `getModelList()` deviennent illisibles et
 *    non déterministes. On fixe donc des identifiants stables.
 */

/**
 * Identifiant stable du modèle primaire (Groq).
 *
 * Forme `provider/model`, comme le routeur de modèles de Mastra. C'est une
 * simple étiquette : `prepareModels` ne fait que `modelConfig.id || model.modelId`
 * et s'en sert pour `findIndex`, les journaux et `reorderModels` — elle n'est
 * jamais analysée, le modèle étant déjà une instance résolue.
 */
export const PRIMARY_MODEL_ID = 'groq/llama-3.3-70b-versatile';

/** Identifiant stable du modèle de repli (Mistral). */
export const FALLBACK_MODEL_ID = 'mistral/mistral-large-latest';

/**
 * Budget de reprise accordé au DERNIER maillon de la chaîne uniquement.
 *
 * Politique asymétrique, volontairement :
 *
 * - Maillons non terminaux → `maxRetries: 0`. Un 429 signifie « quota épuisé chez
 *   CE fournisseur maintenant ». Attendre sur lui consomme le budget d'exécution
 *   de la fonction serverless sans rien gagner, alors qu'un autre fournisseur,
 *   avec un quota distinct, est disponible immédiatement. Basculer coûte moins
 *   cher que patienter.
 * - Dernier maillon → `maxRetries: 1`. Il n'y a plus rien vers quoi basculer ;
 *   une reprise bornée est la dernière défense. Mastra applique alors son
 *   back-off (1 s) et respecte `Retry-After`, plafonné à 30 s
 *   (`DEFAULT_MAX_RETRY_AFTER_MS`, `agent-Dj30gJa3.js:15675`).
 *
 * Pourquoi 1 et pas 2 : la fonction Vercel n'a pas de `maxDuration` explicite dans
 * `vercel.json`, donc 60 s. Une seule reprise plafonne la latence ajoutée à ~30 s
 * dans le pire cas ; deux reprises pourraient atteindre 60 s et faire expirer la
 * requête — soit exactement l'échec qu'on cherche à éviter.
 *
 * ## Journalisation de la chaîne complète des échecs
 *
 * Vérifié empiriquement (clé Groq invalide + Mistral valide, puis les deux
 * invalides — voir `/tmp/.../scratchpad/probe-fallback.mjs`, non versionné) :
 * la bascule fonctionne réellement dans cette version. Mais Mastra émet DEUX
 * logs `Upstream LLM API error` distincts, et un seul des deux est fiable :
 *
 * - Par tentative (`agent-Dj30gJa3.js:23729`, message
 *   `Upstream LLM API error from ${provider} (model: ${modelId})`) : fiable,
 *   `provider`/`modelId` viennent de `currentStep.model`, réaffecté à chaque
 *   tentative avec le modèle qui vient réellement d'être appelé.
 * - En fin de run (`agent-Dj30gJa3.js:29829-29842`, message nu `Upstream LLM
 *   API error`, `provider`/`modelId` en métadonnées séparées) : **trompeur**.
 *   `payload.model` provient de `capabilities.llm.getModel()`
 *   (`agent-Dj30gJa3.js:30111`), et `getModel()`/`getProvider()`/`getModelId()`
 *   sur ce wrapper de chaîne retournent inconditionnellement `#firstModel`
 *   (`agent-Dj30gJa3.js:26004-26010`, assigné une fois pour toutes à
 *   `models[0]` en `25994`) — jamais le modèle qui a réellement produit
 *   l'erreur finale. Reproduit dans
 *   `tests/unit/shared/model-fallback-chain-logging.test.ts` avant correctif :
 *   `{ error: <échec mistral.chat>, provider: 'groq.chat', modelId:
 *   'llama-3.3-70b-versatile' }` — l'échec de Mistral, le DERNIER maillon,
 *   attribué à Groq, le PREMIER. C'est exactement ce qui a fait perdre du
 *   temps en diagnostic : ce second log ne peut pas être utilisé tel quel
 *   pour savoir QUEL maillon a réellement échoué.
 *
 * `withChainFailureLogging` compense en enveloppant chaque modèle : un échec
 * de `doGenerate`/`doStream` est journalisé via `src/shared/logger` (JSON
 * structuré, PII masquée, respecte `LOG_LEVEL`) avec le `chainId`, le
 * `provider` et le `modelId` **du maillon qui vient réellement d'échouer**,
 * puis l'erreur est relancée inchangée — aucun changement de comportement
 * pour Mastra, uniquement une observation fiable en plus. Ce log ne dépend
 * pas de la configuration du `logger` passé (ou non) à `new Agent()`.
 */
export const LAST_RESORT_MAX_RETRIES = 1;

/**
 * Enveloppe un modèle de la chaîne pour journaliser fidèlement chaque échec
 * de `doGenerate`/`doStream` — voir « Journalisation de la chaîne complète
 * des échecs » ci-dessus. Exporté uniquement pour être testable en isolation
 * avec un modèle factice (`tests/unit/shared/model-fallback-chain-logging.test.ts`) ;
 * `makeModelChain` est le seul appelant en dehors des tests.
 */
export function withChainFailureLogging<M extends object>(
  model: M,
  meta: { chainId: string; provider: string; modelId: string },
): M {
  return new Proxy(model, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if ((prop === 'doGenerate' || prop === 'doStream') && typeof value === 'function') {
        const original = value as (...args: unknown[]) => unknown;
        return (...args: unknown[]) =>
          Promise.resolve(original.apply(target, args)).catch((error: unknown) => {
            sharedLogger.error(`Maillon LLM en échec dans la chaîne de repli: ${meta.chainId}`, {
              chainId: meta.chainId,
              provider: meta.provider,
              modelId: meta.modelId,
              errorName: error instanceof Error ? error.name : typeof error,
              errorMessage: error instanceof Error ? error.message : String(error),
              statusCode:
                typeof error === 'object' && error !== null && 'statusCode' in error
                  ? (error as { statusCode?: unknown }).statusCode
                  : undefined,
            });
            throw error;
          });
      }
      return value;
    },
  });
}

export interface ModelChainDeps {
  /** Clé Groq. Par défaut `process.env.GROQ_API_KEY`. */
  groqApiKey?: string;
  /** Clé Mistral. Par défaut `process.env.MISTRAL_API_KEY`. */
  mistralApiKey?: string;
}

/**
 * Construit la chaîne `primaire → repli` consommée par `new Agent({ model })`.
 *
 * Le maillon Mistral est **omis** quand `MISTRAL_API_KEY` est absente. C'est
 * délibéré : un maillon sans identifiants échoue sur une erreur d'authentification
 * qui, étant celle du dernier modèle, remplace l'erreur réelle du primaire dans la
 * réponse. Un vrai 429 Groq était ainsi masqué par un « API key is missing »
 * trompeur. Sans la clé, Groq redevient le dernier maillon et hérite du budget de
 * reprise.
 */
export function makeModelChain(deps: ModelChainDeps = {}): ModelWithRetries[] {
  const groqApiKey = deps.groqApiKey ?? process.env.GROQ_API_KEY;
  const mistralApiKey = deps.mistralApiKey ?? process.env.MISTRAL_API_KEY;

  const chain: Omit<ModelWithRetries, 'maxRetries'>[] = [
    {
      id: PRIMARY_MODEL_ID,
      model: withChainFailureLogging(createGroq({ apiKey: groqApiKey })('llama-3.3-70b-versatile'), {
        chainId: PRIMARY_MODEL_ID,
        provider: 'groq',
        modelId: 'llama-3.3-70b-versatile',
      }),
    },
  ];

  if (mistralApiKey) {
    chain.push({
      id: FALLBACK_MODEL_ID,
      model: withChainFailureLogging(createMistral({ apiKey: mistralApiKey })('mistral-large-latest'), {
        chainId: FALLBACK_MODEL_ID,
        provider: 'mistral',
        modelId: 'mistral-large-latest',
      }),
    });
  }

  return chain.map((entry, index) => ({
    ...entry,
    maxRetries: index === chain.length - 1 ? LAST_RESORT_MAX_RETRIES : 0,
  }));
}

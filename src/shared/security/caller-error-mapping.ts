/**
 * Requalification des erreurs d'APPELANT renvoyées en `500` par Mastra.
 *
 * ## Le problème
 *
 * Une entrée invalide sur un workflow renvoie aujourd'hui :
 *
 * ```
 * POST /api/workflows/documentGenerationWorkflow/start-async  {"inputData":{}}
 * → HTTP 500  {"error":"Invalid input data: \n- employeeId: Required\n- documentType: Required"}
 * ```
 *
 * Le corps est juste, le code ne l'est pas : une faute du client est présentée comme une
 * panne serveur. Conséquences concrètes — l'alerting se déclenche pour rien, et les clients
 * comme les proxies bien élevés **rejouent** automatiquement les 5xx.
 *
 * ## Pourquoi on ne peut pas faire mieux que matcher le message
 *
 * `Workflow.#validateSchema` (`@mastra/core/dist/agent-Dj30gJa3.js:5944`) lève pourtant une
 * erreur parfaitement qualifiée :
 *
 * ```js
 * throw new MastraError({
 *   category: ErrorCategory.USER,            // ← le signal sémantique idéal
 *   id: 'WORKFLOW_SCHEMA_VALIDATION_FAILED',
 *   text: `Invalid ${type}: \n` + issues…,
 * })
 * ```
 *
 * Mais `handleError` (`@mastra/server/dist/server/handlers/error.js:63`) fait ensuite :
 *
 * ```js
 * throw new HTTPException(apiError.status || apiError.details?.status || 500, {
 *   message: apiError.message, stack: apiError.stack, cause: apiError.cause,
 * })
 * ```
 *
 * Il transmet `apiError.cause` — la cause du `MastraError`, **pas** le `MastraError`.
 * `category` et `id` sont donc perdus avant d'atteindre le moindre middleware. Vérifié
 * expérimentalement : au niveau middleware, `e.category` et `e.cause?.category` valent tous
 * deux `undefined`. Le message est le seul signal survivant.
 *
 * On matche donc sur le message, en le gardant **le plus étroit possible**. C'est fragile par
 * nature : une reformulation en amont dans Mastra désactive silencieusement la requalification
 * (on repart alors sur des 500, soit le comportement actuel — dégradation sûre, jamais un
 * masquage de vraie panne). Le test `caller-error-mapping.test.ts` fige les préfixes attendus.
 *
 * Correctif durable : que Mastra propage `category`/`status`. À remonter en amont.
 */

/**
 * Préfixes émis par `#validateSchema`, dérivés du template `Invalid ${type}: ` où `type`
 * appartient à un ensemble fermé lu dans le source (`input data`, `initial data`,
 * `request context`). Ne pas élargir sans relire le source.
 */
const CALLER_ERROR_PREFIXES = [
  'Invalid input data:',
  'Invalid initial data:',
  'Invalid request context:',
] as const;

/** Code renvoyé à la place du 500 pour une faute d'appelant. */
export const CALLER_ERROR_STATUS = 400;

export interface HttpErrorLike {
  status?: number;
  message?: string;
}

/**
 * Une erreur est-elle imputable à l'appelant ?
 *
 * Deux conditions cumulatives, volontairement restrictives :
 *  1. le statut actuel est bien `500` — on ne touche JAMAIS à un 401, 404, 422… déjà corrects ;
 *  2. le message commence par un préfixe de validation connu.
 *
 * Tout le reste — y compris une vraie panne serveur dont le message contiendrait par accident
 * ces mots ailleurs qu'en tête — reste un 500.
 */
export function isCallerError(error: HttpErrorLike | undefined | null): boolean {
  if (!error || error.status !== 500) return false;

  const message = typeof error.message === 'string' ? error.message.trimStart() : '';
  if (!message) return false;

  return CALLER_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix));
}

/**
 * Middleware Mastra/Hono : requalifie une faute d'appelant `500` en `400`.
 *
 * Portée : à monter sur `/api/*` uniquement. `/slack/events` ne doit PAS être couvert — la
 * route gère déjà ses propres codes (200/400/401) et le comportement de rejeu de Slack en
 * dépend directement.
 *
 * Le corps et le message sont conservés à l'identique : seul le code de statut change.
 */
/**
 * Le corps d'une réponse d'erreur Mastra est-il une faute d'appelant ?
 *
 * Vérifié en production : l'`HTTPException` levée par le handler N'ARRIVE PAS jusqu'au
 * middleware — Hono la convertit en `Response` en amont. Inspecter la réponse après
 * `next()` est donc le SEUL point d'accroche qui fonctionne réellement ; le `try/catch`
 * est conservé en second filet pour les chemins qui, eux, propagent.
 */
export function isCallerErrorBody(status: number, body: string): boolean {
  if (status !== 500) return false;

  // Le corps brut est le repli, PAS une initialisation : Mastra renvoie parfois du texte nu
  // plutôt que du JSON, et l'y chercher quand même est exactement ce qui a permis de
  // reconnaître les erreurs de validation. L'initialiser à `''` en plus rendait
  // l'affectation du bloc `try` morte pour le compilateur — et masquait qu'aucune des deux
  // branches ne peut laisser `message` indéfini.
  let message: string;
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    message = typeof parsed.error === 'string' ? parsed.error : String(parsed.message ?? '');
  } catch {
    message = body;
  }

  return isCallerError({ status, message });
}

interface MiddlewareContext {
  res?: Response;
}

export function createCallerErrorMiddleware(options: { onRemap?: (message: string) => void } = {}) {
  return async (c: unknown, next: () => Promise<void>): Promise<Response | void> => {
    try {
      await next();
    } catch (error) {
      const httpError = error as HttpErrorLike & { getResponse?: () => Response };
      if (!isCallerError(httpError)) throw error;

      options.onRemap?.(String(httpError.message));

      const original =
        typeof httpError.getResponse === 'function' ? httpError.getResponse() : undefined;
      const body = original
        ? await original.clone().text()
        : JSON.stringify({ error: httpError.message });

      return new Response(body, {
        status: CALLER_ERROR_STATUS,
        headers: original?.headers ?? { 'content-type': 'application/json' },
      });
    }

    // Chemin NOMINAL : la réponse existe déjà, il n'y a jamais eu d'exception ici.
    const ctx = c as MiddlewareContext;
    const res = ctx?.res;
    if (!res || res.status !== 500) return;

    // `clone()` obligatoire : lire le corps de `res` le consommerait pour le client.
    const body = await res.clone().text();
    if (!isCallerErrorBody(res.status, body)) return;

    options.onRemap?.(body);

    return new Response(body, {
      status: CALLER_ERROR_STATUS,
      headers: res.headers,
    });
  };
}

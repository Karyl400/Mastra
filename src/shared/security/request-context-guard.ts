/**
 * Garde contre l'USURPATION d'identité par le corps HTTP sur `/api/*`.
 *
 * ## Le trou
 *
 * Mastra fusionne `body.requestContext` dans le contexte serveur et n'écarte que
 * `RESERVED_CONTEXT_KEYS` — vérifié dans le paquet installé
 * (`@mastra/server/dist/constants-*.js`) : la liste tient `mastra__*` et `organizationId`,
 * et **aucune clé `slack*`**.
 *
 * Or c'est sur ces clés que se décident les droits :
 *  - `slackEmployeeId` → `canReadPersonRecord` (dossier RH, historique de notifications,
 *    génération de document au nom de quelqu'un) ;
 *  - `slackAccessLevel` → `getUserConversations` et `canPerformSideEffects` ;
 *  - `slackChannel` / `slackThreadTs` → où part un fichier livré.
 *
 * Un appelant porteur de `MASTRA_API_TOKEN` pouvait donc se déclarer n'importe qui. La route
 * n'est pas anonyme — elle est protégée par le bearer — mais **le jeton de service valait
 * l'usurpation totale**, ce qui n'est pas ce qu'un jeton de service est censé valoir.
 *
 * L'invariant écrit en tête de `slack-request-context.ts` — « une valeur que le modèle ne peut
 * pas écrire » — ne tenait donc que sur `/slack/events`, seul producteur légitime. Et
 * `/slack/events` ne passe PAS par ce middleware : il est monté hors du préfixe `/api`, et
 * s'authentifie par signature HMAC.
 *
 * ## Pourquoi REFUSER plutôt qu'ASSAINIR
 *
 * Retirer les clés en silence laisserait l'appel aboutir avec un contexte différent de celui
 * demandé. Les tools dégraderaient proprement (`readSlackContext` rend `undefined` hors Slack,
 * c'est leur cas nominal) et rendraient une réponse plausible — donc une tentative
 * d'usurpation ressemblerait à un succès partiel, et ne laisserait aucune trace lisible.
 *
 * Il n'existe **aucun appelant légitime** de `/api/*` qui ait une raison de poser une clé
 * `slack*` : le playground n'en connaît pas, et le seul producteur est une autre route. La
 * seule intention possible est donc l'usurpation. On échoue bruyamment.
 *
 * ## Pourquoi un PRÉFIXE et non la liste des clés
 *
 * La liste vit dans `src/shared/slack-request-context.ts` et s'allonge — `slackEmployeeId` y a
 * été ajoutée le 2026-08-13, bien après l'écriture des trois premières. Une liste recopiée ici
 * couvrirait les clés d'aujourd'hui et laisserait passer celles de demain, en silence, sans
 * qu'aucun type ne bouge ni qu'aucun test ne rougisse — c'est la classe de défaut la plus
 * fréquente de ce dépôt (`documents.content`, `emailSent: false`). Le préfixe couvre la
 * famille entière ; un test vérifie que toutes les clés déclarées le portent bien.
 */
import { CALLER_ERROR_STATUS } from './caller-error-mapping';

/**
 * Toute clé de `requestContext` commençant par ceci est réputée produite par le serveur, et
 * n'a donc rien à faire dans un corps de requête. Comparé en minuscules.
 */
export const FORGEABLE_CONTEXT_PREFIX = 'slack';

interface GuardedRequest {
  req?: { raw?: Request };
}

/**
 * Le corps n'est lu que sur les méthodes qui en portent un. `Request.clone()` est
 * OBLIGATOIRE : lire `raw.json()` consommerait le flux, et toute requête `/api/*` légitime
 * partirait ensuite sur un corps vide — le middleware casserait exactement ce qu'il protège.
 */
export function createRequestContextGuard(options: { onReject?: (keys: string[]) => void }) {
  return async (c: unknown, next: () => Promise<void>): Promise<Response | void> => {
    const forged = await readForgedKeys((c as GuardedRequest)?.req?.raw);

    if (forged.length === 0) {
      await next();
      return;
    }

    options.onReject?.(forged);

    return new Response(
      JSON.stringify({
        error:
          'requestContext must not carry server-issued keys: ' +
          forged.join(', ') +
          '. These are set by the Slack events route and cannot be supplied by a caller.',
      }),
      { status: CALLER_ERROR_STATUS, headers: { 'content-type': 'application/json' } },
    );
  };
}

/**
 * ⚠️ Ne lève JAMAIS. Un corps illisible n'est pas l'affaire de ce garde : Mastra le rejettera
 * lui-même, et lever ici transformerait une faute d'appelant en 500 — précisément ce que le
 * middleware voisin (`caller-error-mapping`) existe pour défaire.
 */
async function readForgedKeys(raw: Request | undefined): Promise<string[]> {
  if (!raw || raw.method === 'GET' || raw.method === 'HEAD') return [];

  let body: unknown;
  try {
    body = await raw.clone().json();
  } catch {
    return [];
  }

  const context = (body as { requestContext?: unknown } | null)?.requestContext;
  if (!context || typeof context !== 'object' || Array.isArray(context)) return [];

  return Object.keys(context).filter((key) =>
    key.toLowerCase().startsWith(FORGEABLE_CONTEXT_PREFIX),
  );
}

import type { WebClient } from '@slack/web-api';
import { logger } from '../../../../shared/logger';

/**
 * Marqueur de progression Slack — « le bot est en train de réfléchir ».
 *
 * POURQUOI CE MODULE
 * ------------------
 * Un appel LLM prend 2 à 17 s (jusqu'à ~21 s quand le back-off du dernier
 * maillon de la chaîne de fallback se déclenche, cf. CLAUDE.md). Pendant tout
 * ce temps l'utilisateur ne voit RIEN : le bot paraît muet. On poste donc
 * immédiatement un message court, puis on le REMPLACE (`chat.update`) par la
 * réponse finale — un seul message dans le fil, jamais deux.
 *
 * POURQUOI PAS `assistant.threads.setStatus`
 * ------------------------------------------
 * C'est la seule vraie API « typing indicator » de Slack
 * (`node_modules/@slack/web-api/dist/types/request/assistant.d.ts`,
 * `AssistantThreadsSetStatusArguments`). Elle n'opère que sur un *assistant
 * thread* — le conteneur créé par la fonctionnalité « Agents & AI Apps », que
 * l'app Kisso n'active pas. Sur un canal ou un DM ordinaire il n'y a pas de
 * thread assistant à cibler. Le repli `postMessage` + `update` ci-dessous ne
 * dépend, lui, que de `chat:write` — un scope réellement accordé au bot.
 *
 * PROPRIÉTÉ CRITIQUE — CETTE BRIQUE N'EST JAMAIS UN POINT DE PANNE
 * ---------------------------------------------------------------
 * Le marqueur est un CONFORT. Tout échec sur son chemin (`not_in_channel`,
 * `rate_limited`, réseau, `message_not_found` à la mise à jour) est journalisé
 * en `warn` et le traitement continue : `resolve()` se rabat alors sur un
 * `chat.postMessage` normal. Le bot répond même sans indicateur.
 *
 * Seule exception, et elle est délibérée : si la LIVRAISON FINALE elle-même
 * échoue (mise à jour ET repli), `resolve()` propage — l'appelant doit savoir
 * que sa réponse n'a atteint personne, exactement comme avec un `postMessage`
 * direct aujourd'hui. `fail()`, lui, ne lève jamais : il est déjà sur le chemin
 * d'erreur, et y remplacer une exception par une autre ne ferait qu'effacer la
 * cause d'origine.
 *
 * ZÉRO TOKEN LLM : aucun appel de modèle sur ce chemin.
 */

/** Cible du marqueur. `threadTs` absent = message posté à la racine du canal. */
export interface ProgressTarget {
  channel: string;
  /**
   * Fil de discussion. En DM le bot ne threade PAS par conception (la réponse
   * serait enfouie hors de la conversation principale) : l'appelant passe alors
   * `undefined`.
   */
  threadTs?: string;
}

export interface ProgressHandle {
  /**
   * Remplace le marqueur de progression par le texte final.
   *
   * Ne lève que si la réponse n'a pas pu être délivrée DU TOUT (mise à jour
   * échouée *et* repli `postMessage` échoué).
   */
  resolve(text: string): Promise<void>;
  /**
   * Abandonne le marqueur et le remplace par un message d'erreur.
   * Ne lève jamais — on est déjà sur le chemin d'erreur.
   */
  fail(text: string): Promise<void>;
}

/**
 * Texte du marqueur : français, tutoiement, sobre, sans emoji.
 *
 * Cohérent avec `sanitizeAgentOutput`, qui retire déjà les emojis de toute
 * réponse d'agent : un marqueur émaillé détonnerait juste avant une réponse qui
 * n'en porte aucun. Volontairement court — il ne survit que quelques secondes.
 */
export const PROGRESS_MARKER_TEXT = 'Je regarde ça, un instant…';

/**
 * Sous-ensemble de `WebClient` réellement consommé.
 *
 * Un `WebClient` complet reste accepté (c'est un sur-type structurel) ; ce type
 * ne sert qu'à documenter la surface utilisée : deux méthodes, rien d'autre.
 */
type ProgressClient = Pick<WebClient, 'chat'>;

/** Le marqueur ne part pas / ne se met pas à jour : on continue sans lui. */
function warnDegraded(message: string, channel: string, error: unknown): void {
  logger.warn(message, { channel, error });
}

/**
 * Poste un marqueur de progression et rend de quoi le remplacer.
 *
 * BUDGET DE LATENCE — on n'attend PAS l'aller-retour Slack.
 * `startProgress()` rend la main dès la microtâche suivante : la promesse du
 * `postMessage` est conservée et n'est attendue qu'au moment de conclure. Le
 * marqueur part donc en parallèle de l'appel LLM au lieu de le retarder de
 * 200-500 ms. La promesse est immédiatement munie d'un `.catch()` pour qu'un
 * échec ne remonte jamais en rejet non géré, et l'attendre dans `settle()`
 * garantit l'ordre : jamais de marqueur qui atterrit APRÈS la réponse finale.
 *
 * ⚠️ À n'appeler QUE dans la tâche de fond, après l'ACK HTTP des 3 s de Slack.
 *
 * PAS DE RAFRAÎCHISSEMENT PÉRIODIQUE, décision assumée :
 *  1. chaque rafraîchissement est un aller-retour réseau de plus, et
 *     `chat.update` est limité en débit par Slack (palier « Tier 3 ») ;
 *  2. un timer récurrent maintient l'invocation serverless en vie et doit être
 *     annulé sur TOUS les chemins de sortie, sinon il ronge le `maxDuration`
 *     de 60 s — un point de panne ajouté pour un gain cosmétique ;
 *  3. il courrait contre `resolve()` : une mise à jour en vol au moment de la
 *     réponse finale ÉCRASERAIT cette réponse par « je regarde ça… ». C'est le
 *     risque décisif ;
 *  4. le pire cas mesuré est ~21 s ; l'utilisateur a déjà un signal visible et
 *     horodaté. Le rafraîchir n'apporte rien qu'une mention « modifié ».
 */
export async function startProgress(
  client: ProgressClient,
  target: ProgressTarget,
): Promise<ProgressHandle> {
  const { channel, threadTs } = target;

  const post = (text: string): Promise<{ ts?: string }> =>
    client.chat.postMessage(threadTs ? { channel, text, thread_ts: threadTs } : { channel, text });

  // Lancé sans `await` : voir « BUDGET DE LATENCE » ci-dessus. Le `.catch()`
  // est posé ici même — sans lui, un échec du marqueur produirait un rejet non
  // géré (le `settle()` qui l'attend peut arriver plusieurs secondes plus tard).
  const markerTs: Promise<string | undefined> = post(PROGRESS_MARKER_TEXT)
    .then((response) => {
      const ts = response?.ts;
      if (!ts) {
        warnDegraded('Slack progress marker was posted without a ts', channel, undefined);
        return undefined;
      }
      return ts;
    })
    .catch((error: unknown) => {
      warnDegraded(
        'Unable to post the Slack progress marker — continuing without it',
        channel,
        error,
      );
      return undefined;
    });

  /**
   * Le marqueur n'est consommable qu'UNE fois.
   *
   * Sans ce verrou, un second `resolve()` (ou un `fail()` après un `resolve()`)
   * réécrirait le même message et EFFACERAIT la réponse déjà livrée. Une fois
   * consommé, toute conclusion supplémentaire part en message distinct.
   */
  let markerConsumed = false;

  const settle = async (text: string): Promise<void> => {
    const ts = markerConsumed ? undefined : await markerTs;

    if (ts) {
      markerConsumed = true;
      try {
        await client.chat.update({ channel, ts, text });
        return;
      } catch (error: unknown) {
        // `message_not_found`, `cant_update_message`, réseau… : le marqueur est
        // perdu, mais la réponse, elle, doit partir.
        warnDegraded(
          'Unable to update the Slack progress marker — posting the answer as a new message',
          channel,
          error,
        );
      }
    }

    await post(text);
  };

  return {
    // La livraison finale échoue → l'appelant doit le savoir (cf. en-tête).
    resolve: (text: string) => settle(text),

    fail: async (text: string): Promise<void> => {
      try {
        await settle(text);
      } catch (error: unknown) {
        logger.error('Unable to deliver the Slack failure message', { channel, error });
      }
    },
  };
}

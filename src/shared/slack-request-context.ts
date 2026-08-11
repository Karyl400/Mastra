/**
 * Contexte Slack transporté jusqu'aux tools — canal, thread, auteur.
 *
 * ## Pourquoi ce module existe
 *
 * Un tool n'avait AUCUN moyen de savoir dans quel canal ni dans quel thread poster : il
 * reçoit son `inputData` du modèle, et le modèle ne connaît pas — et ne doit pas connaître —
 * l'identifiant du canal Slack. C'est le point bloquant recensé dans les dettes du dépôt :
 * sans lui, aucun tool ne peut livrer un fichier dans la conversation d'où vient la demande.
 *
 * ## Pourquoi un module PARTAGÉ et pas des chaînes en dur des deux côtés
 *
 * Le producteur vit dans `features/notification/infrastructure/handlers` et les consommateurs
 * dans les `application/tools` d'AUTRES features. Ni l'un ni l'autre ne peut importer son
 * vis-à-vis sans violer la règle de dépendance du dépôt (verrouillée par
 * `tests/unit/quality/architecture.test.ts`). `src/shared/` est le seul emplacement commun —
 * c'est déjà le rôle qu'y tiennent `security/`, `logger` et `llm/`.
 *
 * Les trois clés sont le CONTRAT entre les deux bords. Les dupliquer en littéraux ferait
 * qu'un renommage d'un seul côté couperait la livraison sans qu'aucun type ne bouge, et sans
 * qu'aucun test ne rougisse.
 *
 * ## Coût en tokens : ZÉRO
 *
 * Le `RequestContext` de Mastra est un canal d'injection de dépendances côté serveur : il ne
 * traverse ni le prompt, ni les schémas de tools, ni le tool-result. Rien de ce qui passe ici
 * n'entre dans la fenêtre du modèle — contrainte dure du projet (plafond Groq 12 000
 * tokens/minute, déjà dominé par les schémas JSON des tools).
 */
import { RequestContext } from '@mastra/core/request-context';

/**
 * Clés du registre. Préfixe `slack` volontaire : le `RequestContext` est un espace de noms
 * PLAT partagé avec Mastra lui-même (`mastra__resourceId`, `mastra__threadId`, …) et avec
 * tout futur producteur de contexte.
 */
export const SLACK_CHANNEL_KEY = 'slackChannel';
export const SLACK_THREAD_TS_KEY = 'slackThreadTs';
export const SLACK_USER_ID_KEY = 'slackUserId';

export interface SlackToolContext {
  /** Identifiant de canal : `D…` (DM), `C…` (public), `G…` (privé). */
  channel: string;
  /**
   * `thread_ts ?? ts` en canal ; **`undefined` en DM, par conception**.
   *
   * Threader un DM enfouit le message hors de la conversation principale — le bot a paru
   * muet des heures en production pour cette raison exacte. Un fichier uploadé avec un
   * `thread_ts` en DM reproduirait le même enfouissement, en pire : la personne verrait la
   * phrase « voici ton document » sans jamais voir le document.
   */
  threadTs?: string;
  /** Auteur du message. Sert à adresser une livraison de repli (DM, email), pas à router. */
  slackUserId?: string;
}

/** Chaîne non vide, ou `undefined`. Une valeur d'espaces vaut absence. */
function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Construit le contexte à passer à `agent.generate(messages, { requestContext })`.
 *
 * Les champs vides ne sont PAS posés : `has(SLACK_THREAD_TS_KEY) === false` en DM est une
 * information exploitable côté tool, là où une clé présente à `undefined` obligerait chaque
 * consommateur à refaire la distinction.
 */
export function buildSlackRequestContext(context: SlackToolContext): RequestContext {
  const entries: Array<readonly [string, unknown]> = [];

  const channel = nonEmptyString(context.channel);
  if (channel) entries.push([SLACK_CHANNEL_KEY, channel]);

  const threadTs = nonEmptyString(context.threadTs);
  if (threadTs) entries.push([SLACK_THREAD_TS_KEY, threadTs]);

  const slackUserId = nonEmptyString(context.slackUserId);
  if (slackUserId) entries.push([SLACK_USER_ID_KEY, slackUserId]);

  return new RequestContext(entries);
}

/**
 * Lecture DÉFENSIVE du contexte depuis un tool.
 *
 * Le même tool est appelable hors Slack — playground Mastra, route HTTP, workflow, test
 * unitaire — et le `RequestContext` est alors vide (le runtime en crée un par défaut). Rendre
 * `undefined` est donc le cas NORMAL de ces chemins, pas une erreur : c'est ce qui dit au tool
 * « je ne sais pas où poster », à lui de dégrader proprement.
 *
 * Aucune exception ne sort d'ici, quelle que soit la valeur reçue : ce serait transformer un
 * chemin de livraison secondaire en panne de la réponse entière, exactement ce que le dépôt
 * proscrit.
 *
 * La lecture se fait par CONTRAT STRUCTUREL (`get(key)`) et non par `instanceof
 * RequestContext` : le runtime peut fournir un proxy ou une autre implémentation, et un
 * `instanceof` casserait aussi si deux copies du paquet cohabitaient dans le bundle.
 */
export function readSlackContext(requestContext: unknown): SlackToolContext | undefined {
  if (typeof requestContext !== 'object' || requestContext === null) return undefined;

  const get = (requestContext as { get?: unknown }).get;
  if (typeof get !== 'function') return undefined;

  try {
    const read = (key: string): unknown =>
      (get as (this: unknown, key: string) => unknown).call(requestContext, key);

    const channel = nonEmptyString(read(SLACK_CHANNEL_KEY));
    // Sans canal il n'y a rien à livrer : un contexte partiel vaut pas de contexte, plutôt
    // qu'un objet à moitié rempli que chaque appelant devrait revalider.
    if (!channel) return undefined;

    const context: SlackToolContext = { channel };

    // Dégradation partielle assumée : un champ annexe corrompu ne coûte pas la livraison,
    // il ramène seulement au comportement « pas de thread » / « auteur inconnu ».
    const threadTs = nonEmptyString(read(SLACK_THREAD_TS_KEY));
    if (threadTs) context.threadTs = threadTs;

    const slackUserId = nonEmptyString(read(SLACK_USER_ID_KEY));
    if (slackUserId) context.slackUserId = slackUserId;

    return context;
  } catch {
    return undefined;
  }
}

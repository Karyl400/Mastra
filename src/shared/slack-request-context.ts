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
/**
 * `event.ts` du message TRAITÉ — l'identifiant du RUN, pas du fil.
 *
 * Distinct de `SLACK_THREAD_TS_KEY`, et la distinction est la raison d'être de cette clé :
 * `threadTs` est `undefined` en DM par conception, donc `channel` seul ne discrimine pas
 * deux messages successifs d'une même conversation directe. Sans ce champ, une garde
 * d'idempotence portée par le canal bloquerait le deuxième document légitimement demandé
 * dix minutes plus tard.
 */
export const SLACK_EVENT_TS_KEY = 'slackEventTs';
export const SLACK_ACCESS_LEVEL_KEY = 'slackAccessLevel';
/**
 * `employees.id` du DEMANDEUR — l'identifiant qui permet de répondre à « est-ce son propre
 * dossier qu'il consulte ? ».
 *
 * Le handler le résout déjà (`resolveRequesterIdentity`) et l'injecte dans le préambule pour
 * que le modèle sache s'identifier. Il ne descendait PAS jusqu'aux tools, qui n'avaient donc
 * aucun moyen de distinguer une lecture de soi d'une lecture d'autrui. Encore la classe de
 * défaut la plus fréquente de ce dépôt : deux bords corrects, aucun câblage entre les deux.
 *
 * ⚠️ Il voyage ici et NULLE PART AILLEURS pour ce qui est de l'AUTORISATION. La valeur est
 * aussi dans le préambule, mais celle-là sert au modèle à s'exprimer ; on ne décide jamais
 * d'un droit sur une valeur qui a traversé la fenêtre du modèle — un attaquant y écrit.
 */
export const SLACK_EMPLOYEE_ID_KEY = 'slackEmployeeId';

/**
 * COUVERTURE DES EXTRAITS — la seule clé de ce module qui remonte des tools vers le handler.
 *
 * ## Pourquoi elle existe
 *
 * Trois formes ont été essayées pour dire à l'utilisateur qu'un résumé de canal ne porte que
 * sur un ÉCHANTILLON, et les trois ont été MESURÉES EN ÉCHEC en production, sur le même
 * canal : un champ `coverage`, ignoré ; le même texte renommé `hint`, ignoré aussi (un champ
 * séparé se lit comme une métadonnée, quel que soit son nom) ; puis la phrase inlinée avant
 * les extraits, que le modèle lit sans la relayer — le 2026-08-18 il a conclu « Aucun
 * obstacle concret n'est mentionné » sur 6 messages vus sur 8, exactement ce que cette phrase
 * lui interdit. Une consigne d'agent réécrite pour couvrir l'affirmation NÉGATIVE a été
 * déployée puis mesurée en échec le même jour.
 *
 * Deux agents, deux consignes, deux échecs : une consigne est PROBABLE, le code est GARANTI.
 * Le tool écrit donc ici, le handler accole la note, et le modèle n'est plus sur le chemin.
 *
 * ## Pourquoi c'est SÛR
 *
 * `createRequestContextGuard` REFUSE toute clé de préfixe `slack` venue du corps HTTP — il
 * surveille le préfixe et non une liste recopiée, précisément pour couvrir d'avance les clés
 * pas encore écrites. Celle-ci ne peut donc pas être forgée par un appelant `/api/*`.
 *
 * ## Coût en tokens : ZÉRO
 *
 * Comme tout ce module : le `RequestContext` ne traverse ni le prompt, ni les schémas de
 * tools, ni le tool-result.
 */
export const SLACK_EXCERPT_COVERAGE_KEY = 'slackExcerptCoverage';

/**
 * ⚠️ NE LÈVE JAMAIS. Un tool ne doit pas échouer parce qu'il n'a pas pu poser une note :
 * l'échantillon reste utile sans son avertissement, l'inverse n'est pas vrai.
 */
export function writeExcerptCoverage(requestContext: unknown, coverage: string): void {
  writeContextNote(requestContext, SLACK_EXCERPT_COVERAGE_KEY, coverage);
}

/**
 * LE DESTINATAIRE D'UN DOCUMENT — seconde clé remontant des tools vers le handler.
 *
 * ## Pourquoi elle existe, et pourquoi elle ressemble tant à la précédente
 *
 * Même histoire, même issue. Le bloc DOCUMENTS impose au modèle de citer le `recipient` rendu
 * par `generateDocument` : c'est la mesure de VISIBILITÉ posée le 2026-08-14 contre l'erreur
 * de destinataire — celle qui a enregistré « Bienvenue Awa » sous l'UUID de Karyl et envoyé le
 * fichier à l'adresse de Karyl. Mesuré en production le 2026-08-19 sur DEUX sondes document :
 * **le modèle ne le cite pas**. Une mesure de visibilité qui ne se déclenche pas ne mesure
 * rien, et elle est pire qu'absente : on la croit en place.
 *
 * Troisième consigne d'agent mesurée en échec après la couverture des extraits et la rédaction
 * du contenu. Le verdict du dépôt ne bouge pas : une consigne est PROBABLE, le code est
 * GARANTI.
 *
 * ⚠️ Le handler n'accole la note QUE si la réponse ne nomme pas déjà la personne
 * (`textMentionsName`). Une redite de machine sur une réponse déjà juste serait exactement le
 * « ton robotique » qu'on cherche par ailleurs à supprimer.
 */
export const SLACK_DOCUMENT_RECIPIENT_KEY = 'slackDocumentRecipient';

/** ⚠️ NE LÈVE JAMAIS — même contrat que `writeExcerptCoverage`. */
export function writeDocumentRecipient(requestContext: unknown, recipient: string): void {
  writeContextNote(requestContext, SLACK_DOCUMENT_RECIPIENT_KEY, recipient);
}

/** Rend `undefined` hors Slack — cas NORMAL du playground, d'un workflow ou d'un test. */
export function readDocumentRecipient(requestContext: unknown): string | undefined {
  return readContextNote(requestContext, SLACK_DOCUMENT_RECIPIENT_KEY);
}

/**
 * La plomberie commune aux notes qui remontent des tools vers le handler.
 *
 * ⚠️ Factorisée le 2026-08-19, à l'arrivée de la SECONDE note. Deux copies de soixante lignes
 * de `try`/`catch` défensifs auraient divergé au premier durcissement — et c'est justement le
 * genre de duplication silencieuse que ce dépôt paie le plus cher. Les deux notes gardent en
 * revanche leurs fonctions nommées : elles n'ont pas la même sémantique, et un appelant ne
 * doit pas pouvoir écrire n'importe quelle clé du contexte.
 *
 * NE LÈVE JAMAIS : un tool ne doit pas échouer parce qu'il n'a pas pu poser une note.
 */
function writeContextNote(requestContext: unknown, key: string, value: string): void {
  if (!value.trim()) return;
  if (typeof requestContext !== 'object' || requestContext === null) return;

  const set = (requestContext as { set?: unknown }).set;
  if (typeof set !== 'function') return;

  try {
    (set as (this: unknown, k: string, v: unknown) => void).call(requestContext, key, value);
  } catch {
    // Silencieux à dessein — voir ci-dessus.
  }
}

function readContextNote(requestContext: unknown, key: string): string | undefined {
  if (typeof requestContext !== 'object' || requestContext === null) return undefined;

  const get = (requestContext as { get?: unknown }).get;
  if (typeof get !== 'function') return undefined;

  try {
    return nonEmptyString((get as (this: unknown, k: string) => unknown).call(requestContext, key));
  } catch {
    return undefined;
  }
}

/**
 * Rend `undefined` hors Slack (playground, route HTTP, workflow, test) : c'est le cas NORMAL
 * de ces chemins, exactement comme `readSlackContext`.
 */
export function readExcerptCoverage(requestContext: unknown): string | undefined {
  return readContextNote(requestContext, SLACK_EXCERPT_COVERAGE_KEY);
}

/**
 * Ce que le demandeur a le droit de déclencher — décidé en CODE par
 * `features/directory/domain/services/access-policy.ts`, jamais par un modèle.
 *
 * Il voyage ici et NULLE PART AILLEURS : le mettre dans le prompt reviendrait à demander au
 * modèle de s'auto-limiter sur une entrée qu'un attaquant contrôle. `PLAN-ARCHITECTURE.md`
 * §3.1 : un garde-fou LLM échoue « ouvert ET bruyant » — le texte passe *et devient attesté
 * conforme*. Une autorisation qui se négocie n'est pas une autorisation.
 */
export type SlackAccessLevel = 'denied' | 'readonly' | 'full';

const ACCESS_LEVELS: ReadonlySet<string> = new Set(['denied', 'readonly', 'full']);

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
  /**
   * `event.ts` du message en cours de traitement — unique par message, DM compris.
   *
   * Sert de clé de RUN aux gardes d'idempotence des tools à effet de bord. Absent hors
   * Slack (playground, workflow, test), où la garde doit alors se désactiver plutôt que
   * de replier sur une clé partagée.
   */
  eventTs?: string;
  /** Auteur du message. Sert à adresser une livraison de repli (DM, email), pas à router. */
  slackUserId?: string;
  /**
   * `employees.id` du demandeur. **`undefined` signifie « pas de fiche »**, ce qui est le cas
   * COURANT et non le cas limite : cinq humains dans ce workspace, une seule fiche employé.
   * Un tool ne doit donc jamais en déduire un refus par absence — seulement l'impossibilité
   * de reconnaître une lecture de SOI.
   */
  employeeId?: string;
  /**
   * Niveau d'accès du demandeur. **`undefined` signifie « non évalué »**, pas « autorisé » :
   * c'est le cas des chemins hors Slack (playground, route HTTP, workflow, test), où il n'y a
   * pas de demandeur à évaluer. Un tool qui exige `full` doit donc traiter l'absence comme le
   * chemin historique, sans quoi brancher cette clé casserait tous les autres appelants.
   */
  accessLevel?: SlackAccessLevel;
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

  const eventTs = nonEmptyString(context.eventTs);
  if (eventTs) entries.push([SLACK_EVENT_TS_KEY, eventTs]);

  const slackUserId = nonEmptyString(context.slackUserId);
  if (slackUserId) entries.push([SLACK_USER_ID_KEY, slackUserId]);

  const employeeId = nonEmptyString(context.employeeId);
  if (employeeId) entries.push([SLACK_EMPLOYEE_ID_KEY, employeeId]);

  if (context.accessLevel) entries.push([SLACK_ACCESS_LEVEL_KEY, context.accessLevel]);

  return new RequestContext(entries);
}

/**
 * Un tool à EFFET DE BORD peut-il s'exécuter pour ce demandeur ?
 *
 * Rendre `true` sur un contexte absent est délibéré et c'est le point délicat : sans cela,
 * brancher l'autorisation couperait d'un coup le playground, les workflows et les tests, qui
 * n'ont pas de demandeur Slack. L'absence de contexte n'est pas un refus — c'est un chemin
 * où la question ne se pose pas. Le refus se décide sur une valeur PRÉSENTE et connue.
 *
 * Corollaire assumé : la protection ne vaut que sur le chemin Slack. C'est le seul qui soit
 * atteignable par un invité externe, donc le seul où le risque existe ; les routes `/api/*`
 * sont déjà derrière un jeton (`createApiAuthConfig`).
 */
/**
 * LA RÈGLE, écrite UNE FOIS : son propre dossier toujours, celui d'autrui au niveau `full`.
 *
 * ⚠️ Les deux fonctions publiques ci-dessous délèguent ici, et elles restent DEUX — c'est
 * délibéré. Elles nomment deux droits distincts (lire un dossier / agir dessus) qui, à ce jour,
 * se décident de la même façon ; leurs sites d'appel doivent continuer de dire lequel ils
 * exercent. Ce qui ne doit pas exister en double, c'est la RÈGLE : deux copies d'une décision
 * d'autorisation divergent, c'est une question de temps et non de discipline. Si l'une des deux
 * doit un jour s'écarter de l'autre, ce sera une modification visible ici, pas un glissement.
 *
 * Trois propriétés, dans cet ordre :
 *
 *  1. **Pas de contexte ⇒ autorisé.** Playground, workflow, route `/api/*` (déjà derrière un
 *     jeton), test : il n'y a pas de demandeur Slack à évaluer, et refuser y casserait le
 *     parcours d'onboarding, qui envoie l'email de bienvenue sans aucun demandeur.
 *  2. **Son propre dossier : toujours.** Comparaison sur `employees.id`, AVANT le niveau. Sans
 *     elle, la frontière par RÔLE serait inactivable — depuis le 2026-08-20, `readonly` est le
 *     cas nominal de TOUT LE MONDE sauf une personne.
 *  3. **Celui d'autrui : `full` exigé**, c'est-à-dire le manager.
 *
 * ⚠️ Une cible absente ou vide ne peut PAS valoir « soi-même » : sans référent, la comparaison
 * serait vraie par défaut, et omettre le paramètre à un site d'appel rendrait la rétrogradation
 * inopérante en silence. Idem côté demandeur — un `employeeId` non résolu n'autorise rien.
 */
function mayTouchRecord(requestContext: unknown, targetEmployeeId: string | undefined | null) {
  const context = readSlackContext(requestContext);
  if (!context) return true;

  const target = nonEmptyString(targetEmployeeId);
  if (target && context.employeeId && context.employeeId === target) return true;

  return context.accessLevel === undefined || context.accessLevel === 'full';
}

export function canPerformSideEffects(
  requestContext: unknown,
  targetEmployeeId?: string | null,
): boolean {
  return mayTouchRecord(requestContext, targetEmployeeId);
}

/**
 * Le demandeur peut-il lire le dossier RH de la personne `targetEmployeeId` ?
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Le défaut : trois lectures RH SANS AUCUN contrôle du demandeur
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Audit du 2026-08-13. `getEmployeeProfile`, `getTaskList` (retiré depuis) et
 * `getNotificationHistory` ne
 * contenaient pas une seule référence au demandeur — ni `readSlackContext`, ni rien
 * d'équivalent. N'importe quel membre du workspace obtenait donc le dossier complet d'un
 * collègue : département, poste, date d'entrée, manager, avancement d'intégration,
 * historique des notifications reçues.
 *
 * Et l'UUID nécessaire n'était pas un secret : `findEmployeeByEmail` le rend depuis une simple
 * adresse email. La chaîne complète « email d'un collègue → UUID → dossier » était ouverte, en
 * deux messages, à quiconque sait écrire dans Slack. C'est un bot RH.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * La règle, et pourquoi elle n'est pas inventée ici
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  1. **Son propre dossier : toujours.** Comparaison sur `employees.id`, jamais sur un nom.
 *  2. **Le dossier d'autrui : niveau `full` exigé.** C'est EXACTEMENT la règle déjà appliquée
 *     par `getUserConversations` pour la mémoire d'autrui (`authorizeOtherMemoryRead`) et par
 *     `canPerformSideEffects` pour les effets de bord. On ne crée pas une troisième
 *     politique : deux copies d'une décision d'autorisation divergent, c'est une question de
 *     temps et non de discipline.
 *
 * ⚠️ **Le mode observation est HÉRITÉ, il n'est pas rejoué ici.** Le niveau porté par le
 * contexte est déjà l'`effective` calculé par `SlackAccessGuard`, qui rend `full` à tout le
 * monde tant que `AUTHZ_ENFORCE` n'est pas posé. Conséquence à connaître avant de conclure
 * quoi que ce soit de cette fonction : **tant que l'application n'est pas activée, elle ne
 * refuse rien.** C'est délibéré — ces flux existaient avant elle, et les rétrograder d'un coup
 * casserait des usages légitimes (c'est le raisonnement déjà tranché dans `access-guard.ts`,
 * et l'inverse de celui de `disclosure-policy.ts`, dont la capacité était NEUVE).
 *
 * ⚠️ Corollaire, depuis le 2026-08-20 : `resolveAccess` n'accorde `full` qu'au porteur du rôle
 * `manager` (`slack_directory.role`). **`readonly` est donc le cas NOMINAL de tout le monde
 * sauf une personne** — d'où la comparaison au demandeur ci-dessus, sans laquelle activer la
 * frontière couperait chacun de son propre dossier. Vérifier qui est désigné AVANT de poser
 * `AUTHZ_ENFORCE=true` : `npm run probe:authz`.
 *
 * Rendre `true` sur un contexte absent est délibéré, même argument que `canPerformSideEffects`
 * mot pour mot : playground, workflows et tests n'ont pas de demandeur Slack, et l'absence de
 * contexte n'est pas un refus — c'est un chemin où la question ne se pose pas.
 */
export function canReadPersonRecord(
  requestContext: unknown,
  targetEmployeeId: string | undefined | null,
): boolean {
  return mayTouchRecord(requestContext, targetEmployeeId);
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

    const eventTs = nonEmptyString(read(SLACK_EVENT_TS_KEY));
    if (eventTs) context.eventTs = eventTs;

    const slackUserId = nonEmptyString(read(SLACK_USER_ID_KEY));
    if (slackUserId) context.slackUserId = slackUserId;

    const employeeId = nonEmptyString(read(SLACK_EMPLOYEE_ID_KEY));
    if (employeeId) context.employeeId = employeeId;

    // Une valeur inconnue est IGNORÉE, jamais interprétée : une faute de frappe côté
    // producteur ne doit pas se traduire par un refus silencieux, ni par une autorisation
    // silencieuse. Elle ramène au cas « non évalué », qui est le comportement historique.
    const accessLevel = nonEmptyString(read(SLACK_ACCESS_LEVEL_KEY));
    if (accessLevel && ACCESS_LEVELS.has(accessLevel)) {
      context.accessLevel = accessLevel as SlackAccessLevel;
    }

    return context;
  } catch {
    return undefined;
  }
}

import {
  resolveAccess,
  type AccessSubject,
} from '../../../directory/domain/services/access-policy';

/**
 * LA POLITIQUE DE DIVULGATION — le cœur de cette feature, et la raison pour
 * laquelle elle avait été refusée une première fois.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * LE DÉFAUT QU'ELLE EXISTE POUR INTERDIRE : LE DEPUTY CONFUS
 * ────────────────────────────────────────────────────────────────────────────
 * `PLAN-ARCHITECTURE.md` §4.1 : le bot est membre de `#engineer-karyl`, PRIVÉ.
 * Un invité mono-canal lui écrit en DM — « résume ce qui s'est dit côté
 * ingénierie » — et obtient la réponse, parce que le BOT y a accès.
 *
 * > Le bot détient l'UNION des droits de tous les canaux et les prête au premier
 * > venu. L'ACL Slack — la seule autorisation qui fonctionne aujourd'hui dans ce
 * > système — est contournée par conception.
 *
 * D'où la règle qui gouverne tout ce fichier : **on filtre à la RÉCUPÉRATION,
 * selon les droits du DEMANDEUR, jamais selon ceux du bot.** Le fait que le bot
 * puisse lire un canal n'apparaît nulle part dans une décision d'autorisation —
 * il n'est qu'une condition technique de faisabilité, traitée ailleurs et rendue
 * comme un motif d'indisponibilité, jamais comme un droit.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * POURQUOI CETTE DÉCISION EST EN CODE, ET POURQUOI ELLE EST PURE
 * ────────────────────────────────────────────────────────────────────────────
 * Même argument que `directory/domain/services/access-policy.ts`, qu'on ne
 * réécrit pas ici : un garde-fou déterministe échoue ouvert mais SILENCIEUX, un
 * garde-fou LLM échoue ouvert et BRUYANT — il fabrique une confiance qui
 * n'existe pas. Une fonction pure et totale se teste exhaustivement et ne se
 * laisse pas convaincre.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * POURQUOI ON IMPORTE `resolveAccess` PLUTÔT QUE DE LE RÉÉCRIRE
 * ────────────────────────────────────────────────────────────────────────────
 * C'est le seul import de ce fichier, et il traverse une frontière de feature —
 * `domain` → `domain`, donc sans violer la règle de dépendance (rien de
 * `infrastructure`, aucun paquet de framework ; le garde-fou d'architecture
 * l'accepte).
 *
 * L'alternative — redéclarer ici « qui est de la maison » — reproduirait la
 * règle du domaine email, la frontière de label (`notkissohq.com` ne doit pas
 * passer pour `kissohq.com`) et l'ordre des règles. Deux copies d'une décision
 * d'autorisation divergent : c'est une question de temps, pas de discipline. On
 * accepte donc le couplage, qui est TYPÉ — un renommage chez `directory` casse
 * la compilation, il ne produit pas un silence.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ⚠️ CE QUI DIFFÈRE VOLONTAIREMENT DE `SlackAccessGuard`
 * ────────────────────────────────────────────────────────────────────────────
 * `access-guard.ts` a un MODE OBSERVATION : tant que `AUTHZ_ENFORCE` n'est pas
 * posé, il calcule la décision, la journalise, et applique `full` à tout le
 * monde. C'est le bon arbitrage LÀ-BAS : il s'interpose devant des flux qui
 * fonctionnaient déjà sans lui, et les rétrograder d'un coup casserait des
 * usages légitimes.
 *
 * ICI, il n'y a rien à protéger : la capacité est NEUVE. Personne ne dépend
 * encore de sa permissivité. Le mode observation y serait donc, littéralement,
 * une divulgation de canaux privés en attendant qu'on pense à la couper. Cette
 * politique est appliquée dès le premier appel, sans variable d'environnement,
 * et son défaut en l'absence de configuration est le REFUS.
 *
 * Conséquence assumée, à connaître avant de câbler : aucun manager désigné ⇒
 * personne n'atteint `full` ⇒ **chacun ne lit que ses propres échanges avec le
 * bot**. Les canaux, eux, restent lisibles par leurs membres : cette porte-là ne
 * dépend d'aucune désignation, mais de l'ACL Slack elle-même.
 *
 * TypeScript pur.
 */

/**
 * Motif de la décision. Journalisé, et rendu au modèle sous forme de `reason`
 * pour qu'il dise CE QUI bloque plutôt que d'inventer une règle métier — défaut
 * mesuré en production (« je ne peux pas modifier un questionnaire qu'elle n'a
 * pas encore reçu », règle qui n'existe nulle part).
 *
 * ⚠️ Un motif nomme la RÈGLE, jamais la donnée : « pas membre du canal » ne dit
 * rien du contenu du canal, ni même s'il existe.
 */
export type DisclosureReason =
  | 'ok_self'
  | 'ok_manager'
  | 'ok_channel_member'
  | 'no_requester'
  | 'requester_denied'
  | 'insufficient_privilege'
  | 'not_channel_member';

export interface DisclosureVerdict {
  readonly allowed: boolean;
  readonly reason: DisclosureReason;
}

/**
 * Le demandeur, tel que le tool le connaît.
 *
 * `slackUserId` et `subject` sont SÉPARÉS à dessein. L'identifiant vient du
 * `requestContext` — il est posé par le serveur, il est toujours là dès qu'on
 * est sur un chemin Slack. Le `subject`, lui, vient de l'annuaire, et peut être
 * `null` (personne jamais synchronisée, panne de la base). Les fondre en un seul
 * objet obligerait à FABRIQUER un sujet pour un inconnu, c'est-à-dire à inventer
 * ses drapeaux `isBot` / `isRestricted` — inventer des faits d'autorisation.
 *
 * Un demandeur inconnu de l'annuaire garde donc son identité (il peut lire ses
 * propres échanges) sans obtenir le moindre privilège.
 */
export interface Requester {
  readonly slackUserId: string;
  readonly subject: AccessSubject | null;
}

const DENIED_LEVEL = 'denied';

/** Refus durs, communs aux deux portes : un bot ou un compte désactivé ne demande rien. */
function hardDenial(requester: Requester): DisclosureVerdict | null {
  if (!requester.subject) return null;
  const decision = resolveAccess(requester.subject);
  return decision.level === DENIED_LEVEL ? { allowed: false, reason: 'requester_denied' } : null;
}

/** Comparaison d'identifiants Slack. Les `U…` sont sensibles à la casse chez Slack. */
function isSamePerson(a: string, b: string): boolean {
  return a.trim() === b.trim() && a.trim().length > 0;
}

/**
 * Puis-je lire les échanges que le BOT a eus avec cette personne ?
 *
 * Trois paliers, dans cet ordre :
 *
 *  1. Refus durs (bot, compte désactivé).
 *  2. **Soi-même : toujours autorisé**, y compris pour un invité mono-canal.
 *     C'est sa propre conversation avec le bot ; la lui refuser au nom de la
 *     protection des données serait un contresens sur ce que ces données sont.
 *  3. Autrui : réservé à `full`, c'est-à-dire au seul porteur du rôle `manager`
 *     (depuis le 2026-08-20 ; c'était « membre de l'organisation » auparavant,
 *     ce qui donnait à chacun la mémoire de tous). Un invité — `is_restricted` ou
 *     `is_ultra_restricted` — ne lit JAMAIS la conversation d'un tiers. C'est
 *     très exactement le scénario de §4.1, transposé de la porte « canal » à la
 *     porte « mémoire », par laquelle il serait autrement passé intact.
 *     ⚠️ Ce palier n'ouvre que les tours `user` : voir `mayDiscloseBotUtterances`.
 *
 * ⚠️ Un appelant qui devrait résoudre la cible pour appeler cette fonction doit
 * passer par `authorizeOtherMemoryRead` D'ABORD — sinon le couple
 * « introuvable » / « pas le droit » devient un oracle d'annuaire.
 *
 * ⚠️ Le palier 2 se teste AVANT le palier 3 : l'inverse refuserait à un invité
 * l'accès à ses propres messages.
 */
export function authorizeMemoryRead(
  requester: Requester | null,
  targetSlackUserId: string,
): DisclosureVerdict {
  // Hors Slack (playground, route HTTP, workflow, test), `readSlackContext` rend
  // `undefined`. Les autres tools DÉGRADENT dans ce cas — celui-ci REFUSE, et
  // c'est délibéré : pas de demandeur ⇒ pas de droits ⇒ rien à divulguer. Une
  // dégradation ici rendrait la totalité des conversations lisible depuis le
  // playground, c'est-à-dire depuis un chemin sans authentification.
  if (!requester) return { allowed: false, reason: 'no_requester' };

  const denial = hardDenial(requester);
  if (denial) return denial;

  if (isSamePerson(requester.slackUserId, targetSlackUserId)) {
    return { allowed: true, reason: 'ok_self' };
  }

  return authorizeOtherMemoryRead(requester);
}

/**
 * Le palier 3 SEUL : « ai-je le droit de lire les échanges de QUELQU'UN D'AUTRE ? »
 * — sans savoir de qui, et c'est tout l'intérêt.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * POURQUOI CETTE PORTE EXISTE À CÔTÉ DE `authorizeMemoryRead`
 * ────────────────────────────────────────────────────────────────────────────
 * `authorizeMemoryRead` exige un `targetSlackUserId`, donc oblige l'appelant à
 * RÉSOUDRE la cible dans l'annuaire avant de savoir s'il en a le droit. Cet
 * ordre-là fabriquait un ORACLE : « Personne inconnue de l'annuaire » pour une
 * adresse absente contre « tu ne peux montrer que tes échanges » pour une
 * adresse présente. Deux verdicts distinguables, et un invité mono-canal
 * énumère en DM les adresses de l'entreprise, une par une.
 *
 * La réponse est celle de `NEUTRAL_REFUSAL` et celle d'`isMember` dans
 * `slack-channel-history.adapter.ts` : le refus ne renseigne pas sur la sonde
 * qui a porté. Le contrôle rendu indépendant de la cible, l'appelant peut le
 * poser AVANT toute interrogation de l'annuaire — ce qu'on n'interroge pas ne
 * fuite ni par le verdict, ni par le temps de réponse, ni par un journal.
 *
 * ⚠️ Ce n'est PAS un affaiblissement : le droit accordé ici (« lire autrui »)
 * est strictement plus fort que « lire soi-même ». Un appelant qui l'obtient
 * n'a plus rien à vérifier sur l'identité de la cible.
 */
export function authorizeOtherMemoryRead(requester: Requester | null): DisclosureVerdict {
  if (!requester) return { allowed: false, reason: 'no_requester' };

  const denial = hardDenial(requester);
  if (denial) return denial;

  if (!requester.subject) return { allowed: false, reason: 'insufficient_privilege' };

  const decision = resolveAccess(requester.subject);
  return decision.level === 'full'
    ? { allowed: true, reason: 'ok_manager' }
    : { allowed: false, reason: 'insufficient_privilege' };
}

/**
 * Les tours `assistant` de cette conversation peuvent-ils sortir vers ce
 * demandeur ? **Uniquement s'il est la personne concernée.**
 *
 * ────────────────────────────────────────────────────────────────────────────
 * LA FUITE TRANSITIVE QUE CETTE RÈGLE FERME
 * ────────────────────────────────────────────────────────────────────────────
 * La garantie écrite plus bas dans ce fichier — « un membre de l'organisation
 * non membre du canal ne le lit pas non plus » — était contournable par la
 * mémoire, en trois temps :
 *
 *   1. Alice, membre de `#engineer-karyl` (PRIVÉ), en demande un résumé en DM.
 *      `getChannelHistory` vérifie SON appartenance : c'est légitime.
 *   2. La réponse du bot est persistée dans `conversation_turns`, sous la clé
 *      `D…` d'Alice. Le contenu du canal privé a changé de domicile.
 *   3. Bob, `full` mais étranger à `#engineer-karyl`, lit les échanges d'Alice
 *      et récupère le résumé. Le privilège `full` vient d'ouvrir un canal privé
 *      PAR RICOCHET, ce qu'il n'a jamais eu le droit de faire.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * POURQUOI FILTRER LE RÔLE PLUTÔT QUE FERMER LA PORTE
 * ────────────────────────────────────────────────────────────────────────────
 * Restreindre `authorizeMemoryRead` à soi-même fermerait la fuite, mais
 * supprimerait une capacité VOULUE et documentée (le palier 3 ci-dessus). Or
 * l'asymétrie est réelle, et elle est exactement celle des deux rôles :
 *
 *  - un tour `user` est ce que la personne a TAPÉ elle-même. Le bot ne lui a
 *    prêté aucun droit pour l'écrire ; il n'y a là aucune amplification ;
 *  - un tour `assistant` est ce que le BOT a produit — et il le produit en
 *    lisant des sources dont il détient l'union des droits. C'est le seul des
 *    deux qui puisse contenir du canal privé, puisque les tool-results ne sont
 *    jamais persistés (`conversation` ne stocke que du texte) : le contenu de
 *    canal n'atteint la table QUE par la réponse rédigée.
 *
 * On coupe donc l'amplification, pas l'accès. Résiduel assumé et connu : un
 * tour `user` peut recopier du contenu privé, mais c'est la personne elle-même
 * qui l'a divulgué au bot — le bot n'y prête pas ses droits.
 */
export function mayDiscloseBotUtterances(
  requester: Requester | null,
  targetSlackUserId: string,
): boolean {
  if (!requester) return false;
  return isSamePerson(requester.slackUserId, targetSlackUserId);
}

/**
 * Puis-je lire l'historique de ce canal ?
 *
 * **Une seule question compte : le demandeur est-il membre du canal ?** On ne
 * réimplémente pas l'ACL Slack, on la MIROITE — c'est elle qui décide, elle
 * seule, et elle est déjà correcte. Conséquences directes, toutes voulues :
 *
 *  - un invité mono-canal membre de `#kisso-hq` peut lire `#kisso-hq` ; il le
 *    voit déjà dans son client Slack, le lui refuser ici n'ajouterait aucune
 *    sécurité et casserait un usage légitime ;
 *  - le même invité ne peut PAS lire `#engineer-karyl`, quand bien même le bot y
 *    est membre. C'est le scénario §4.1, fermé ;
 *  - un membre de l'organisation non membre du canal ne le lit pas non plus. Le
 *    privilège `full` n'ouvre pas les canaux privés : il ouvre la mémoire du bot,
 *    ce qui n'est pas la même donnée. ⚠️ Cette garantie a été contournable
 *    jusqu'au 2026-08-12 : la mémoire CONTIENT les résumés de canaux privés
 *    rédigés par le bot. Ce qui la rétablit est `mayDiscloseBotUtterances`, pas
 *    la présente fonction.
 *
 * ⚠️ `requesterIsChannelMember` est un FAIT constaté auprès de Slack
 * (`conversations.members`), jamais une valeur produite par le modèle ni lue
 * dans un schéma de tool.
 */
export function authorizeChannelRead(
  requester: Requester | null,
  requesterIsChannelMember: boolean,
): DisclosureVerdict {
  if (!requester) return { allowed: false, reason: 'no_requester' };

  const denial = hardDenial(requester);
  if (denial) return denial;

  return requesterIsChannelMember
    ? { allowed: true, reason: 'ok_channel_member' }
    : { allowed: false, reason: 'not_channel_member' };
}

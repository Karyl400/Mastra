/**
 * Les HUIT court-circuits déterministes : ce à quoi le bot répond SANS aucun appel de
 * modèle, déclaré une seule fois.
 *
 * ## Le défaut que ce module ferme
 *
 * Ces huit cas existaient à DEUX endroits de `slack-events.handler.ts` : la suite de `if`
 * de `handleMessage`, et le prédicat `isAnsweredWithoutModel` qui doit en être — je cite le
 * commentaire d'origine — « le MIROIR EXACT ». Le second gouverne le rationnement : un
 * court-circuit ajouté d'un côté et pas de l'autre fait payer un message qui ne coûte rien.
 *
 * Ce n'est pas théorique. Le défaut d'origine, trouvé en production, est exactement de cette
 * famille : quelqu'un ayant atteint ses 12 messages du jour recevait « J'ai atteint mon
 * quota » pour un simple « bonjour » — et l'aurait reçu pour « je ne vais pas bien ». La
 * correction a consisté à énumérer les cas dans `isAnsweredWithoutModel`… c'est-à-dire à
 * créer la seconde liste qu'il fallait ensuite maintenir à la main.
 *
 * Une seule table, donc, et `isAnsweredWithoutModel` en est DÉRIVÉE. C'est la discipline que
 * le dépôt applique déjà à `shared/agent-capabilities.ts` (« déclarer le câblage une seule
 * fois ») et pour la même raison : deux copies d'une liste divergent au premier changement,
 * en silence, sans qu'aucun type ne bouge.
 *
 * ## Ce que la table ne porte pas
 *
 * L'ORDRE est significatif et il est celui du tableau. Trois entrées portent `reply: null` :
 * elles AGISSENT (effacer, épingler, publier un formulaire) et leur exécution reste dans le
 * handler, qui seul a les dépôts et le client Slack. Ce que la table garantit pour elles,
 * c'est que leur prédicat est le même des deux côtés — le seul point où la divergence
 * coûtait quelque chose.
 */
import { GREETING_REPLY, isBareGreeting } from '../../../../shared/greeting';
import { DISTRESS_REPLY, detectsDistress } from '../../../../shared/distress';
import { requestsErasure } from '../../../../shared/forget';
import { extractPinnedFact } from '../../../../shared/pin-fact';
import { requestsProfileForm } from '../../../../shared/profile-request';
import {
  CONTENT_FREE_REPLY,
  TOO_LONG_REPLY,
  hasNoTextualContent,
} from '../../../../shared/message-shape';
import { MAX_USER_INPUT_LENGTH } from '../../../../shared/security/llm-guardrail';

/** Sous-type Slack d'un message portant une pièce jointe. */
export const FILE_SHARE_SUBTYPE = 'file_share';

/**
 * Réponse à une pièce jointe. Déterministe, zéro token.
 *
 * Elle dit ce qui EST, jamais ce qui pourrait être : pas de « pour l'instant », pas de
 * « bientôt ». Le produit ne lit aucun fichier et rien n'indique qu'il le fera ; laisser
 * croire l'inverse ferait attendre quelqu'un pour rien. Elle propose immédiatement le
 * chemin qui, lui, fonctionne.
 */
export const FILE_ATTACHMENT_REPLY =
  'Je ne sais pas lire les pièces jointes — ni les images, ni les PDF, ni les documents. ' +
  "Dis-moi en quelques mots ce dont tu as besoin et je m'en occupe.";

/** Ce qu'un court-circuit a besoin de savoir pour se prononcer. */
export interface DeterministicReplyInput {
  /** Texte déjà nettoyé de la mention du bot. */
  readonly text: string;
  /** `subtype` de l'événement Slack, seul critère non textuel de la table. */
  readonly subtype?: string;
  /** Sert au seul journal de la détresse — jamais à la décision. */
  readonly isDirectMessage?: boolean;
}

export interface DeterministicReply {
  /** Repris tel quel dans le journal, pour que le chemin emprunté soit lisible. */
  readonly name: string;
  readonly matches: (input: DeterministicReplyInput) => boolean;
  /**
   * Texte figé, ou `null` quand le court-circuit AGIT et que le handler doit s'en charger
   * (effacement, épinglage, publication du formulaire).
   */
  readonly reply: string | null;
  /**
   * Le tour entre-t-il en mémoire conversationnelle ?
   *
   * ⚠️ VRAI pour la seule salutation, et c'est nécessaire : sans elle, un fil ouvert par
   * « bonjour » ne serait jamais « engagé » et `shouldAbandonThreadReply` écarterait le
   * message SUIVANT. Faux partout ailleurs, et délibérément : ni « 🎉 » ni un pavé tronqué
   * n'aident le tour d'après, et une confidence de détresse n'a pas à être conservée plus
   * longtemps que nécessaire.
   */
  readonly remembersTurn?: boolean;
  /** Champs de journal propres à ce cas. Voir les mises en garde, cas par cas. */
  readonly logFields?: (input: DeterministicReplyInput) => Record<string, unknown>;
}

/**
 * ⚠️ L'ORDRE EST CONTRACTUEL, il est documenté dans `CLAUDE.md`, et chaque position a été
 * choisie contre un cas réel. Ne pas réordonner sans relire les justifications.
 */
export const DETERMINISTIC_REPLIES: readonly DeterministicReply[] = [
  {
    // En tête : une salutation n'est ni une détresse ni une demande. C'est aussi le seul
    // court-circuit qui doive laisser une trace en mémoire — voir `remembersTurn`.
    name: 'bare_greeting',
    matches: ({ text }) => isBareGreeting(text),
    reply: GREETING_REPLY,
    remembersTurn: true,
  },
  {
    // Avant les deux formes ci-dessous : un fichier arrive souvent avec un texte vide, et
    // c'est la pièce jointe qui fait sens, pas le vide.
    name: 'file_attachment',
    matches: ({ subtype }) => subtype === FILE_SHARE_SUBTYPE,
    reply: FILE_ATTACHMENT_REPLY,
  },
  {
    // Zéro lettre, zéro chiffre : le modèle n'a rien à traiter. Il coûtait pourtant un run
    // complet, ≈ 5 % du budget quotidien, pour répondre « que puis-je faire ? ».
    name: 'no_textual_content',
    matches: ({ text }) => hasNoTextualContent(text),
    reply: CONTENT_FREE_REPLY,
  },
  {
    // La borne EXISTE déjà dans `wrapUserInput`, mais elle y lève une `SecurityBlockError`
    // que `userFacingFailure` traduit en refus de POLITIQUE — là où le problème est une
    // TAILLE. On ne déplace pas la borne, on la double en amont, sur la MÊME constante :
    // celle de `wrapUserInput` reste la garantie des appelants qui ne passent pas par ici.
    name: 'over_length',
    matches: ({ text }) => text.length > MAX_USER_INPUT_LENGTH,
    reply: TOO_LONG_REPLY,
    // ⚠️ La longueur, JAMAIS le texte : c'est un DM, et ce chemin est précisément celui des
    // copier-coller de documents internes.
    logFields: ({ text }) => ({ textLength: text.length }),
  },
  {
    // Avant la frontière d'autorisation : quelqu'un qui va mal ne doit pas se heurter à une
    // politique d'accès. C'est le seul endroit de ce dépôt où un défaut peut nuire à une
    // PERSONNE — et l'absence d'appel LLM écarte au passage tout outil parasite.
    name: 'distress',
    matches: ({ text }) => detectsDistress(text),
    reply: DISTRESS_REPLY,
    // ⚠️ Ni le texte ni l'auteur : c'est la confidence la plus sensible que ce produit
    // puisse recevoir. On journalise QUE le fait, pour savoir que le chemin a servi.
    logFields: ({ isDirectMessage }) => ({ isDirectMessage }),
  },
  {
    // ── À partir d'ici, les court-circuits qui AGISSENT. Ils restent exécutés par le
    // handler ; seul leur PRÉDICAT vit ici, pour que le miroir ne puisse pas diverger.
    //
    // Placé avant la frontière d'autorisation, comme la détresse : effacer ses données est
    // un droit, pas un privilège de niveau `full`.
    name: 'erasure_request',
    matches: ({ text }) => requestsErasure(text),
    reply: null,
  },
  {
    // Mémoriser un fait ne consomme aucun token, et quelqu'un qui a épuisé son quota doit
    // pouvoir corriger ce que le bot sait de lui — c'est même le geste qui réduira ses
    // tours suivants.
    name: 'pin_fact',
    matches: ({ text }) => extractPinnedFact(text) !== null,
    reply: null,
  },
  {
    // Remplir son propre dossier n'est pas un privilège : un invité rétrogradé en `readonly`
    // doit pouvoir se déclarer, c'est même le seul geste qui puisse l'en faire sortir.
    name: 'profile_form_request',
    matches: ({ text }) => requestsProfileForm(text),
    reply: null,
  },
];

/**
 * Ce message sera-t-il traité SANS aucun appel de modèle ?
 *
 * DÉRIVÉ de la table, donc structurellement incapable de diverger des court-circuits — ce
 * qui était toute la fragilité de la version précédente, maintenue à la main.
 *
 * Ce que ce prédicat NE dit PAS : que le message sera effectivement traité. Il peut encore
 * être écarté plus loin (fil non engagé, doublon, auteur inconnu). Il dit seulement qu'il ne
 * coûtera pas un token — la seule question que se pose le rationnement.
 */
export function isAnsweredWithoutModel(input: DeterministicReplyInput): boolean {
  return DETERMINISTIC_REPLIES.some((entry) => entry.matches(input));
}

/**
 * Le premier court-circuit à réponse FIGÉE qui s'applique, s'il y en a un.
 *
 * Les entrées agissantes (`reply: null`) sont ignorées ici : elles précèdent ou suivent dans
 * la table, mais toutes les entrées figées lui sont antérieures, donc les balayer d'abord
 * donne exactement l'ordre d'évaluation d'origine.
 */
export function findStaticReply(input: DeterministicReplyInput): DeterministicReply | undefined {
  return DETERMINISTIC_REPLIES.find((entry) => entry.reply !== null && entry.matches(input));
}

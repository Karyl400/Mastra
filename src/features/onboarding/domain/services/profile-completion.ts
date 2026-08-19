/**
 * « C'est fait » — la vérification, et ce qu'on répond dans chaque cas.
 *
 * ## Pourquoi une VÉRIFICATION, et pas une simple confirmation
 *
 * Un bouton qui se contente de dire « super, merci ! » est un bouton qui MENT dès que la
 * personne se trompe — et la faute la plus banale est de croire avoir terminé. Ce dépôt a
 * déjà payé cette famille de défaut trois fois : `emailSent: false` sous
 * `status: 'success'`, `documents.content` perdu en silence, un suivi de tâches qu'aucun
 * mécanisme ne faisait avancer. Chaque fois, le système AFFIRMAIT un état qu'il n'avait pas
 * constaté.
 *
 * D'où la règle ici : on regarde la base, et la réponse ne dit que ce qu'on y a vu.
 *
 * ## Pourquoi le domaine, et pourquoi une fonction PURE
 *
 * Elle est appelée depuis la route d'interactivité (clic) ET depuis le handler Slack (la
 * personne écrit « j'ai fini » plutôt que de cliquer — c'est le second chemin explicitement
 * demandé). Deux appelants, une seule règle : la dupliquer garantirait qu'un jour le bouton
 * et la phrase ne disent plus la même chose.
 */

/** Ce qu'il faut avoir en base pour qu'un dossier soit exploitable. */
import { INTERVIEW_QUESTION_DAILY } from './interview-chat';
import {
  PROFILE_CHAT_INTRO_NO_RECORD,
  PROFILE_QUESTIONS,
  answersFromRecord,
  nextProfileStep,
  profileChatIntroMissing,
} from './profile-chat';

export interface ProfileSnapshot {
  readonly firstName: string | null | undefined;
  readonly lastName: string | null | undefined;
  readonly email: string | null | undefined;
  readonly position: string | null | undefined;
}

export interface ProfileVerdict {
  readonly complete: boolean;
  /** Champs manquants, en français, dans l'ordre où le guide les a annoncés. */
  readonly missing: readonly string[];
  /** Le texte à poster, en mrkdwn Slack. */
  readonly reply: string;
  /**
   * Le dossier reste-t-il à compléter ?
   *
   * ⚠️ S'appelait `offerForm` jusqu'au 2026-08-19, quand la réponse posait un bouton ouvrant
   * une modale. Cette modale ne s'ouvrait jamais : un `trigger_id` expire en 3 s et le
   * démarrage à froid mesuré est de 5,2 s. La complétion se fait désormais EN CONVERSATION,
   * et `reply` porte déjà la première question — le nom devait suivre, sinon il décrirait un
   * produit qui n'existe plus.
   */
  readonly needsProfileChat: boolean;
}

/**
 * ⚠️ mrkdwn Slack (`*gras*`), jamais markdown GitHub (`**gras**`).
 *
 * Ces textes sont postés en DUR par la route et le handler : ils ne passent par AUCUN filtre.
 * `sanitizeAgentOutput`, qui convertit le markdown, n'a qu'un seul site d'appel —
 * `response.text`, la réponse d'un MODÈLE. Un `**` s'afficherait littéralement, ce qui a été
 * constaté le 2026-08-18 sur le message de détresse, le pire endroit possible.
 */
/**
 * ⚠️ La question vient d'`interview-chat.ts`, elle n'est PAS réécrite ici.
 *
 * C'est la machine à états de l'entretien qui l'exige : l'étape en cours est reconnue en
 * comparant le dernier tour du bot à cette constante. Une reformulation locale — même
 * strictement synonyme — casserait la reconnaissance en silence, sans qu'aucun type ne bouge
 * ni qu'aucun test de cette constante ne rougisse. Le dépôt connaît bien cette classe de
 * défaut : deux bords corrects, aucun câblage entre les deux.
 */
const NEXT_STEP =
  `Ton dossier est complet, je l’ai vérifié. *Parlons de toi*, maintenant — deux questions, ` +
  `pas plus.\n\n${INTERVIEW_QUESTION_DAILY}`;

/**
 * Nom LISIBLE de chaque champ. Le guide écrit dit « ton adresse email professionnelle » ; la
 * réponse doit employer les mêmes mots, sans quoi la personne cherche un champ qui n'existe
 * pas sous ce nom.
 */
const FIELD_LABELS: Readonly<Record<keyof ProfileSnapshot, string>> = {
  firstName: 'ton prénom',
  lastName: 'ton nom',
  email: 'ton adresse email',
  position: 'l’intitulé de ton poste',
};

const FIELD_ORDER: ReadonlyArray<keyof ProfileSnapshot> = [
  'firstName',
  'lastName',
  'email',
  'position',
];

function filled(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Le verdict.
 *
 * ⚠️ `null` (aucune fiche) et une fiche INCOMPLÈTE ne produisent pas le même texte, et c'est
 * la distinction qui compte. « Il me manque ton poste » adressé à quelqu'un qui n'a aucun
 * dossier serait faux et déroutant : il ne manque pas un champ, il manque tout. C'est la même
 * règle que `found: false` porteur d'un `reason` — un résultat vide doit se distinguer d'un
 * identifiant qui ne désigne personne.
 */
export function verifyProfile(snapshot: ProfileSnapshot | null): ProfileVerdict {
  if (snapshot === null) {
    return {
      complete: false,
      missing: FIELD_ORDER.map((field) => FIELD_LABELS[field]),
      reply: `${PROFILE_CHAT_INTRO_NO_RECORD}\n\n${PROFILE_QUESTIONS.firstName}`,
      needsProfileChat: true,
    };
  }

  const missing = FIELD_ORDER.filter((field) => !filled(snapshot[field])).map(
    (field) => FIELD_LABELS[field],
  );

  if (missing.length === 0) {
    return { complete: true, missing: [], reply: NEXT_STEP, needsProfileChat: false };
  }

  // ⚠️ On NOMME ce qui manque. « Ton profil est incomplet » est la version inutile de cette
  // phrase : elle informe la personne qu'elle a un problème sans lui dire lequel, ce qui la
  // renvoie au formulaire pour le découvrir. Le coût de nommer est nul, celui de taire est un
  // aller-retour.
  // ⚠️ LA RÉPONSE CONTIENT DÉJÀ LA PREMIÈRE QUESTION, et c'est indispensable, pas cosmétique :
  // l'état de la machine à états EST le dernier tour `assistant` du fil. Nommer ce qui manque
  // sans rien demander laisserait le fil sans question en attente, et le message suivant de la
  // personne — sa réponse — partirait chez un agent. C'est exactement la faute mesurée le
  // 2026-08-19 sur la machine jumelle de l'entretien.
  const step = nextProfileStep(answersFromRecord(snapshot))!;
  return {
    complete: false,
    missing,
    reply: `${profileChatIntroMissing(missing)}\n\n${PROFILE_QUESTIONS[step]}`,
    needsProfileChat: true,
  };
}

/**
 * Réponse quand la vérification n'a PAS PU avoir lieu.
 *
 * ⚠️ Elle ne dit jamais « ton dossier est incomplet ». Une base indisponible est notre
 * défaut, pas celui de la personne, et le lui imputer l'enverrait corriger un formulaire qui
 * n'a rien à corriger. Elle ne dit pas non plus « c'est bon » : on n'a rien constaté, et
 * c'est tout ce qu'on sait. Même discipline que `null` face à `[]` dans la réconciliation
 * FAIT/NARRATION — sans preuve positive, on se tait sur le fond.
 *
 * mrkdwn Slack, jamais markdown GitHub : ce texte est posté en dur, sans passer par aucun
 * filtre.
 */
export const PROFILE_CHECK_UNAVAILABLE =
  'Je n’arrive pas à consulter les dossiers en ce moment, donc je ne peux pas te confirmer ' +
  'que le tien est complet. Redemande-moi dans un instant.';

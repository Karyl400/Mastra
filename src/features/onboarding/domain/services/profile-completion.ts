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
  /** Faut-il proposer le formulaire ? Uniquement quand il manque vraiment quelque chose. */
  readonly offerForm: boolean;
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
  email: 'ton adresse email professionnelle',
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
      reply:
        'Je ne trouve pas encore de dossier à ton nom — il n’a pas dû être enregistré. ' +
        'Ouvre le formulaire ci-dessous, il est déjà pré-rempli avec ce que Slack sait de toi : ' +
        'il te reste à confirmer.',
      offerForm: true,
    };
  }

  const missing = FIELD_ORDER.filter((field) => !filled(snapshot[field])).map(
    (field) => FIELD_LABELS[field],
  );

  if (missing.length === 0) {
    return { complete: true, missing: [], reply: NEXT_STEP, offerForm: false };
  }

  // ⚠️ On NOMME ce qui manque. « Ton profil est incomplet » est la version inutile de cette
  // phrase : elle informe la personne qu'elle a un problème sans lui dire lequel, ce qui la
  // renvoie au formulaire pour le découvrir. Le coût de nommer est nul, celui de taire est un
  // aller-retour.
  const list =
    missing.length === 1 ? missing[0]! : `${missing.slice(0, -1).join(', ')} et ${missing.at(-1)!}`;
  return {
    complete: false,
    missing,
    reply: `J’ai bien un dossier à ton nom, mais il me manque ${list}. Le formulaire ci-dessous garde ce qui est déjà rempli.`,
    offerForm: true,
  };
}

import { BestEffortStep } from '../value-objects/onboarding-outcome';
import { ESCALATION_CONTACT } from '../../../../shared/escalation';

export const PROFILE_SUBMISSION_FAILED_REPLY =
  "Je n'ai pas réussi à enregistrer ton dossier — ça vient de mon côté, pas de ce que tu as " +
  "saisi. Rien n'a été perdu : réécris-moi « compléter mon profil » et recommence. Si ça " +
  `recommence, dis-le à ${ESCALATION_CONTACT} — je ne peux pas me réparer tout seul.`;

export const PROFILE_EMAIL_TAKEN_REPLY =
  'Ton adresse est déjà rattachée à un dossier archivé, et je ne sais pas le rouvrir ' +
  `moi-même — refaire le parcours donnerait exactement le même résultat. Demande à ` +
  `${ESCALATION_CONTACT} de réactiver ce dossier ou de libérer l'adresse, et je prends la ` +
  "suite dès que c'est fait.";

export function profileSubmissionDegradedReply(missing: readonly string[]): string {
  const opening =
    "Ton dossier est créé — tu peux continuer. Une chose n'a pas abouti de mon côté :";
  const list = missing.map((item) => `\n• ${item}`).join('');
  const closing =
    `\n\nCe n'est pas bloquant, et rien ne se relancera tout seul : si ça compte pour toi, ` +
    `signale-le à ${ESCALATION_CONTACT}.`;
  return `${opening}${list}${closing}`;
}

const STEP_LABELS: Readonly<Record<BestEffortStep, string>> = {
  [BestEffortStep.WelcomeEmail]: "l'email de bienvenue ne t'a pas été envoyé",
  [BestEffortStep.SlackInvite]: "je n'ai pas pu t'ajouter à tes canaux Slack",
};

export function describeMissingSteps(steps: readonly { step: string }[]): string[] {
  const labels = steps
    .map((entry) => STEP_LABELS[entry.step as BestEffortStep])
    .filter((label): label is string => Boolean(label));
  return [...new Set(labels)];
}

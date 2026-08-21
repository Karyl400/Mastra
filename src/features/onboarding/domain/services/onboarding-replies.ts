import { BestEffortStep } from '../value-objects/onboarding-outcome';
import { ESCALATION_CONTACT } from '../../../../shared/escalation';

export const PROFILE_SUBMISSION_FAILED_REPLY =
  "Je n'ai pas réussi à enregistrer ton dossier — ça vient de mon côté, pas de ce que tu as " +
  "saisi. Rien n'a été perdu : réécris-moi « compléter mon profil » et recommence. Si ça " +
  `recommence, dis-le à ${ESCALATION_CONTACT} — je ne peux pas me réparer tout seul.`;

/**
 * ⚠️ UNE ADRESSE OCCUPÉE PAR UNE FICHE SUPPRIMÉE N'EST PAS UNE PANNE — trouvé en production
 * le 2026-08-21, et la distinction est tout l'objet de ce message.
 *
 * `idx_employees_email` est UNIQUE sans prédicat sur `deleted_at`, donc une fiche archivée
 * occupe encore son adresse ; mais les trois résolveurs filtrent `deleted_at`, donc le produit
 * ne la voit pas. Il pose les quatre questions, puis échoue à l'enregistrement — et le message
 * générique conseillait alors de RECOMMENCER, c'est-à-dire de refaire exactement ce qui vient
 * d'échouer. Une boucle sans sortie, dont la personne ne peut pas soupçonner la cause.
 *
 * `DrizzleEmployeeRepository.explainEmailConflict` produisait déjà le diagnostic exact. Il
 * n'atteignait personne. C'est la même famille que `emailSent: false` sous `status: 'success'`
 * : l'information juste existe, et se perd au dernier mètre.
 *
 * ⚠️ Il ne cite NI la date d'archivage NI l'identifiant : ce sont des détails d'implémentation
 * pour quelqu'un qui n'a aucun moyen d'agir dessus. Ce qu'il lui faut est le geste suivant, et
 * la personne à qui le demander.
 */
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

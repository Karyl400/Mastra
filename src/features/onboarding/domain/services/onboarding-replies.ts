import { BestEffortStep } from '../value-objects/onboarding-outcome';

/**
 * Ce que reçoit la personne qui vient de valider le formulaire « Compléter mon profil ».
 *
 * ## Le trou que ce module ferme
 *
 * Le workflow d'onboarding sait déjà distinguer trois issues — `completed`, `degraded`,
 * `failed` — et `onboarding-outcome.ts` existe précisément pour que « réussi » cesse de
 * couvrir « rien n'est parti ». Mais ce verdict s'arrêtait au JOURNAL : sur `failed` comme
 * sur `degraded`, l'appelant écrivait une ligne `logger.error` et rendait la main. La
 * personne qui venait de remplir sa modale ne recevait **rien du tout**, et ne pouvait pas
 * distinguer un succès d'une panne.
 *
 * C'est le mode d'échec que tout ce dépôt combat, arrêté un cran trop tôt : le verdict
 * existait, il n'atteignait personne.
 *
 * ## Ce que ces textes s'interdisent
 *
 * - **Ne jamais dire « c'est fait » sur un échec.** Sur `failed`, il n'y a pas de dossier.
 * - **Ne jamais promettre une reprise automatique.** Il n'existe ni cron, ni poller, ni file
 *   de reprise dans ce système : « je réessaierai plus tard » serait la promesse creuse que
 *   `scheduleReminder` a appris à ne plus faire.
 * - **Nommer ce qui manque, pas un code.** « Ton email de bienvenue n'est pas parti » est
 *   actionnable ; « étape `welcomeEmail` dégradée » ne l'est pas.
 */

/**
 * Échec complet : aucun dossier n'a été créé.
 *
 * On demande de recommencer parce que c'est la seule chose qui puisse marcher — la
 * soumission est idempotente, une seconde tentative ne crée pas de doublon.
 */
export const PROFILE_SUBMISSION_FAILED_REPLY =
  "Je n'ai pas réussi à enregistrer ton dossier — ça vient de mon côté, pas de ce que tu as " +
  "saisi. Rien n'a été perdu : réécris-moi « compléter mon profil » et recommence. Si ça " +
  "recommence, dis-le à l'équipe RH, je ne peux pas me réparer tout seul.";

/**
 * Le dossier EXISTE, mais une étape best-effort a échoué.
 *
 * ⚠️ La liste des étapes manquées est construite à partir du verdict réel, jamais devinée :
 * annoncer un email non parti alors qu'il l'est ferait exactement le mensonge inverse de
 * celui qu'on corrige.
 */
export function profileSubmissionDegradedReply(missing: readonly string[]): string {
  const opening =
    "Ton dossier est créé — tu peux continuer. Une chose n'a pas abouti de mon côté :";
  const list = missing.map((item) => `\n• ${item}`).join('');
  const closing =
    "\n\nCe n'est pas bloquant, et rien ne se relancera tout seul : si ça compte pour toi, " +
    "signale-le à l'équipe RH.";
  return `${opening}${list}${closing}`;
}

/**
 * Traduction des étapes dégradées en langage lisible.
 *
 * Les identifiants d'étape sont du vocabulaire de code ; ils n'ont rien à faire dans un
 * message. Une étape inconnue est OMISE plutôt que rendue telle quelle — mieux vaut une liste
 * incomplète qu'une ligne incompréhensible, et l'ouverture du message dit déjà qu'il manque
 * quelque chose.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠️ CETTE TABLE ÉTAIT INDEXÉE SUR LES NOMS DE L'ENUM, JAMAIS SUR SES VALEURS
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Défaut trouvé le 2026-08-19. Les clés étaient `WelcomeEmail` et `SlackInvite` — les noms des
 * MEMBRES de `BestEffortStep` — alors que le workflow pousse leurs VALEURS, `welcomeEmail` et
 * `slackInvite`. `describeMissingSteps` rendait donc `[]` sur TOUTE dégradation réelle, et
 * `runOnboarding` n'envoie rien quand la liste est vide : **personne n'était jamais prévenu
 * qu'un email de bienvenue n'était pas parti.**
 *
 * C'est la faute exacte que tout ce module dit combattre, dans le module qui le dit : le
 * verdict existait, était calculé, était journalisé — et n'atteignait personne. Rien ne
 * rougissait, parce que les deux bords étaient corrects séparément.
 *
 * Le correctif n'est pas de recopier les bonnes chaînes — la même divergence reviendrait au
 * premier renommage — mais de **dériver la table de l'enum lui-même**. `Record<BestEffortStep,
 * string>` rend de surcroît l'exhaustivité vérifiable à la COMPILATION : ajouter une étape
 * sans son libellé devient une erreur de build, pas un silence.
 */
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

/*
 * ⚠️ `MODAL_FAILED_REPLY` a été SUPPRIMÉ le 2026-08-19, avec les modales elles-mêmes. Il
 * disait « reclique sur le bouton, ça repart en général du premier coup » — une consigne
 * devenue fausse dans les deux moitiés : il n'y a plus de bouton, et ça ne repartait pas.
 */

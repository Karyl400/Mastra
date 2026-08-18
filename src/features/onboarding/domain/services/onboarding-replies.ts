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
 * Les identifiants d'étape (`WelcomeEmail`, `SlackInvite`) sont du vocabulaire de code ; ils
 * n'ont rien à faire dans un message. Une étape inconnue est OMISE plutôt que rendue telle
 * quelle — mieux vaut une liste incomplète qu'une ligne incompréhensible, et l'ouverture du
 * message dit déjà qu'il manque quelque chose.
 */
const STEP_LABELS: Readonly<Record<string, string>> = {
  WelcomeEmail: "l'email de bienvenue ne t'a pas été envoyé",
  SlackInvite: "je n'ai pas pu t'ajouter à tes canaux Slack",
};

export function describeMissingSteps(steps: readonly { step: string }[]): string[] {
  const labels = steps
    .map((entry) => STEP_LABELS[entry.step])
    .filter((label): label is string => Boolean(label));
  return [...new Set(labels)];
}

/**
 * La modale n'a pas pu s'ouvrir.
 *
 * ⚠️ Sans ce message, le symptôme est exactement « le bouton ne fait rien » : le clic est
 * acquitté, la modale n'apparaît pas, et rien ne distingue cette panne d'une Request URL mal
 * configurée. C'est le seul cas où l'utilisateur ne peut RIEN déduire de ce qu'il voit.
 *
 * Il ne nomme pas la cause parce qu'elles sont plusieurs et qu'aucune ne concerne la
 * personne : un jeton expiré, une vue refusée par Slack, un `trigger_id` de plus de trois
 * secondes. Ce qui la concerne, c'est que recliquer a de bonnes chances de marcher.
 */
export const MODAL_FAILED_REPLY =
  "Le formulaire ne s'est pas ouvert — c'est de mon côté. Reclique sur le bouton, ça repart " +
  'en général du premier coup.';

/**
 * « Parlons de toi » — l'entretien post-profil, en CONVERSATION plutôt qu'en modale.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Pourquoi la modale a été retirée
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Pas pour une raison d'ergonomie : parce qu'elle ne s'ouvrait pas. Un `trigger_id` Slack
 * expire **3 secondes** après le clic, et le démarrage à froid de la fonction a été mesuré le
 * 2026-08-18 à 4,9 s, puis jusqu'à 16 s après une longue inactivité. Or l'inactivité est le
 * cas NORMAL ici — ce produit voit ≈ 19 messages par jour, et un arrivant est par définition
 * le premier à écrire. Le bouton était donc structurellement cassé, et son échec ne laissait
 * aucune trace visible : Slack affiche une erreur générique, la modale n'apparaît pas.
 *
 * Un échange écrit n'a aucune contrainte de ce type. Il coûte au pire quelques secondes
 * d'attente, ce qui est le comportement normal d'une conversation.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Pourquoi ZÉRO appel de modèle, et où vit l'état
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Le poste de coût dominant de ce dépôt n'est pas la taille des prompts mais le NOMBRE
 * D'ÉTAPES : chaque aller-retour est une requête pleine chez les deux fournisseurs, sur un
 * budget de ≈ 19 messages par jour. Un entretien « intelligent » de trois tours coûterait à
 * lui seul un sixième de la journée du workspace, pour poser deux questions dont le texte est
 * connu d'avance.
 *
 * L'état n'est stocké NULLE PART, et c'est la clef de la conception : il se lit dans le
 * dernier tour `assistant` du fil, que le handler charge DÉJÀ pour la mémoire
 * conversationnelle. Aucune table, aucune colonne, aucune lecture supplémentaire sur le
 * chemin des 3 secondes de l'ACK.
 *
 * ⚠️ Conséquence assumée : l'historique est borné par `CONVERSATION_TTL_MS` (60 min). Une
 * réponse donnée le lendemain n'est plus reconnue comme une réponse d'entretien et part chez
 * l'agent. C'est un abandon SILENCIEUX mais pas un mensonge — rien n'a été promis entre-temps —
 * et le parcours se relance depuis « C'est fait ». L'alternative (une table d'état) coûterait
 * une lecture par message pour un cas qui se joue en deux minutes.
 */

/**
 * ⚠️ LES DEUX QUESTIONS SONT DES CONSTANTES, et c'est ce qui fait tenir la machine à états :
 * on reconnaît l'étape en cours en COMPARANT le dernier tour du bot à ces chaînes. Les
 * reformuler ailleurs — dans le verdict de « C'est fait », par exemple — casserait la
 * reconnaissance sans qu'aucun type ne bouge et sans qu'aucun test unitaire de ces
 * constantes ne rougisse. C'est pourquoi `profile-completion.ts` importe la première d'ici
 * au lieu de la réécrire.
 *
 * ⚠️ mrkdwn Slack (`*gras*`), jamais markdown GitHub : ces textes sont postés en dur et ne
 * passent par AUCUN filtre — `sanitizeAgentOutput` n'a qu'un seul site d'appel, la réponse
 * d'un modèle.
 */
export const INTERVIEW_QUESTION_DAILY =
  'Dis-moi *ce que tu fais au quotidien*, en une phrase — je m’en sers pour te proposer les ' +
  'bons canaux et pour préparer ton guide d’accueil.';

export const INTERVIEW_QUESTION_STYLE =
  'Noté. Et *comment tu préfères travailler* ? Une phrase suffit : en asynchrone, beaucoup ' +
  'd’échanges, peu de réunions, ce que tu veux.';

/** Étape que la réponse courante vient renseigner. */
export type InterviewStep = 'dailyWork' | 'workStyle';

/**
 * Quelle question le bot vient-il de poser ?
 *
 * ⚠️ Comparaison sur un PRÉFIXE normalisé et non sur l'égalité stricte : le handler accole
 * parfois une note à la réponse (requalification d'un accompli, promesse d'envoi démentie,
 * couverture d'extraits), et Slack renvoie le texte tel qu'il l'a rendu. Une égalité stricte
 * échouerait alors en silence — exactement la classe de défaut que ce dépôt traque.
 */
export function pendingInterviewStep(lastAssistantText: string | undefined): InterviewStep | null {
  const text = (lastAssistantText ?? '').trim();
  if (!text) return null;
  if (text.startsWith(INTERVIEW_QUESTION_STYLE.slice(0, 40))) return 'workStyle';
  if (text.startsWith(INTERVIEW_QUESTION_DAILY.slice(0, 40))) return 'dailyWork';
  return null;
}

/**
 * Longueur maximale conservée pour une réponse.
 *
 * Elle finit dans un document PDF portant le nom de la personne (le gabarit `guide` imprime
 * « Ton quotidien » et « Ta façon de travailler »). Une borne évite qu'un copier-coller de
 * trois pages y atterrisse — et elle vaut aussi comme garde-fou de coût, ces champs étant
 * relus à chaque génération de guide.
 */
export const MAX_INTERVIEW_ANSWER_CHARS = 280;

/**
 * La réponse est-elle exploitable ?
 *
 * ⚠️ On REFUSE le vide et le monosyllabe, et on le dit — sans quoi « ok » serait enregistré
 * comme la description du travail de quelqu'un, puis imprimé dans son guide d'accueil sous
 * « Ton quotidien ». Le seuil est délibérément bas : on écarte l'accusé de réception, pas la
 * concision.
 */
export function captureInterviewAnswer(text: string | undefined): string | null {
  const trimmed = (text ?? '').trim().replace(/\s+/g, ' ');
  if (trimmed.length < 4) return null;
  return trimmed.slice(0, MAX_INTERVIEW_ANSWER_CHARS);
}

/** Ce qu'on répond quand la réponse est trop courte pour vouloir dire quelque chose. */
export const INTERVIEW_TOO_SHORT_REPLY =
  'Il me faut un peu plus que ça — une phrase, même courte. Sinon dis-moi « passe », et on ' +
  'verra ça plus tard.';

/** La personne renonce. Reconnu tôt : insister sur un questionnaire d'accueil est le meilleur
 * moyen de le faire abandonner pour de bon. */
export function skipsInterview(text: string | undefined): boolean {
  const normalized = (text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .trim();
  return /^(passe|plus tard|pas maintenant|skip|non merci|non)\b/.test(normalized);
}

export const INTERVIEW_SKIPPED_REPLY =
  'Pas de souci, on laisse ça de côté. Reviens quand tu veux, je reprendrai où on en est.';

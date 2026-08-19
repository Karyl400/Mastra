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
/**
 * ⚠️ « je m'en sers pour te proposer les bons canaux » a été RETIRÉ le 2026-08-19 : RIEN ne
 * proposait de canal. Le seul écrivain de `onboarding_interview.channels` était la modale,
 * morte le même jour ; le chemin conversationnel écrit `channels: existing?.channels ?? []`.
 * La promesse était faite au PREMIER message utile que reçoit un arrivant.
 *
 * ⚠️ Et un usage RÉEL n'était pas annoncé : cette phrase alimente `findExpertise`. Quand un
 * collègue demande « qui s'occupe du backend ? », il reçoit ces mots-là. Ce que la personne
 * écrit en confiance dans un questionnaire d'accueil devient sa fiche consultable — un
 * changement d'usage que l'en-tête de `find-expertise.ts` disait lui-même devoir « se demander
 * avant de se coder », et qui a été codé sans que la question soit tranchée. On le DIT
 * désormais, ce qui est la moitié la moins chère de la réponse : la personne sait, et rien
 * n'est retiré. Reste au propriétaire à décider si l'annonce suffit.
 */
export const INTERVIEW_QUESTION_DAILY =
  'Dis-moi *ce que tu fais au quotidien*, en une phrase — je m’en sers pour préparer ton ' +
  'guide d’accueil, et pour te retrouver quand un collègue cherche quelqu’un sur ce sujet.';

export const INTERVIEW_QUESTION_STYLE =
  'Noté. Et *comment tu préfères travailler* ? Une phrase suffit : en asynchrone, beaucoup ' +
  'd’échanges, peu de réunions, ce que tu veux.';

/** Étape que la réponse courante vient renseigner. */
export type InterviewStep = 'dailyWork' | 'workStyle';

/**
 * Quelle question le bot vient-il de poser ?
 *
 * ⚠️ `includes`, et surtout PAS `startsWith` — c'est un défaut mesuré en production le
 * 2026-08-19, sur le chemin nominal, alors qu'un commentaire affirmait ici même le contraire.
 * Le message qui pose la première question ne COMMENCE pas par elle : le verdict de
 * « C'est fait » dit « Ton dossier est complet, je l'ai vérifié. On enchaîne. Dis-moi… ».
 * Avec `startsWith`, la reconnaissance échouait donc systématiquement, et la réponse de la
 * personne partait chez l'agent — le tout sans le moindre signal, la question s'affichant
 * parfaitement.
 *
 * Le handler accole par ailleurs des notes en fin de réponse (accompli requalifié, promesse
 * d'envoi démentie, couverture d'extraits) : le texte peut donc être encadré des deux côtés.
 * `includes` est le seul critère qui survive aux deux.
 *
 * ⚠️ STYLE est testé AVANT DAILY, et l'ordre porte un cas réel : rien n'interdit qu'un futur
 * texte cite les deux. La question la plus AVANCÉE doit l'emporter, sinon l'entretien
 * boucherait sur sa première étape.
 */
export function pendingInterviewStep(lastAssistantText: string | undefined): InterviewStep | null {
  const text = (lastAssistantText ?? '').trim();
  if (!text) return null;
  if (text.includes(INTERVIEW_QUESTION_STYLE.slice(0, 40))) return 'workStyle';
  if (text.includes(INTERVIEW_QUESTION_DAILY.slice(0, 40))) return 'dailyWork';
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
  if (isNotAnAnswer(trimmed)) return null;
  return trimmed.slice(0, MAX_INTERVIEW_ANSWER_CHARS);
}

/**
 * Phrases qui ne répondent PAS à la question, tout en étant assez longues pour passer la
 * borne de quatre caractères.
 *
 * ⚠️ Relevé en production le 2026-08-19, sur le chemin réel : « je n'ai pas fini », écrit
 * juste après « ce que tu fais au quotidien ? », a été enregistré comme la description du
 * métier de quelqu'un. Ce champ est imprimé dans le guide d'accueil, sous « Ton quotidien »,
 * dans un document qui porte le nom de la personne.
 *
 * C'est la même famille que le refus de « ok » et « 👍 » : ce qui compte n'est pas la
 * longueur mais le fait que la phrase parle d'AUTRE CHOSE que de la question posée. La liste
 * est FERMÉE et minuscule — la garde qui compte reste la relance, pas l'exhaustivité.
 */
function isNotAnAnswer(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[’´`]/g, "'");

  return /^(?:c'est|cest|j'ai|jai|je n'ai|je nai)\b.{0,24}\b(?:fait|fini|termine|bon)\b/.test(
    normalized,
  );
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

/**
 * ⚠️ « Reviens quand tu veux, je reprendrai où on en est » a été RETIRÉ le 2026-08-19 : aucun
 * mécanisme ne reprend quoi que ce soit. L'état de cette machine EST le dernier tour
 * `assistant` du fil ; après ce texte, c'est LUI le dernier tour, et il ne correspond à aucun
 * marqueur — `pendingInterviewStep` rend `null` immédiatement. Même sans cela, le fil expire
 * en 60 minutes.
 *
 * C'est `status: 'scheduled'` sans ordonnanceur, mot pour mot, dans un fichier dont l'en-tête
 * concédait déjà l'abandon silencieux — puis le dé-concédait dans la réponse.
 *
 * On dit donc ce qui est vrai : le chemin de retour existe, il faut le reprendre du début, et
 * il tient en trois mots.
 */
export const INTERVIEW_SKIPPED_REPLY =
  'Pas de souci, on laisse ça de côté. Si tu changes d’avis, écris-moi « j’ai fini » et on ' +
  'repart de là.';

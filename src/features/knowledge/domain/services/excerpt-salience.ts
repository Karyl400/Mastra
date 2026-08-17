import type { ConversationExcerpt } from '../entities/conversation-excerpt';

/**
 * LA SAILLANCE — quels extraits méritent d'être montrés, et non simplement lesquels sont les
 * plus récents.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Le défaut corrigé
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `selectExcerpts` ne triait que par DATE : on rendait les 6 derniers messages. Or les
 * 6 derniers messages d'un canal ne sont presque jamais les 6 importants — ce sont
 * « ok », « merci », « 👍 », « noté ». À la question « résume ce qui s'est dit dans
 * #kisso-hq », le modèle recevait donc les accusés de réception d'une décision dont il ne
 * voyait pas l'énoncé, et devait combler. Ce dépôt sait ce qu'un modèle fait devant un vide :
 * il invente.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Pourquoi un score en CODE, et pas un appel de modèle
 * ════════════════════════════════════════════════════════════════════════════
 *
 * « Choisis les messages importants » est une tâche qu'un LLM ferait mieux. Elle coûterait un
 * aller-retour de plus par consultation, sur un budget qui se compte en **≈ 19 messages par
 * jour** — et le poste de coût dominant de ce dépôt est le NOMBRE D'ÉTAPES, pas la taille du
 * prompt. Un score déterministe coûte zéro token, est reproductible, et se teste.
 *
 * Il est forcément plus grossier. C'est un compromis assumé, et il est bon ici : on ne
 * demande pas au score de COMPRENDRE la conversation, seulement d'écarter le bruit et de
 * remonter ce qui porte une décision, une question ou un engagement. Le modèle, lui, lit
 * ensuite ce qui a été retenu.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Ce que le score NE fait pas
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Il ne change ni le nombre d'extraits rendus, ni leur taille : la propriété centrale du
 * module voisin — **la sortie ne dépend ni du nombre de messages ni de leur longueur** —
 * reste intacte. Il change QUELS extraits passent, pas COMBIEN.
 *
 * ⚠️ Motifs volontairement SIMPLES, sans quantificateur imbriqué : ce texte vient de Slack et
 * n'est pas fiable. `llm-guardrail.ts` porte déjà un lot de warnings ReDoS, on n'en ajoute pas.
 *
 * ⚠️ TypeScript pur — seul un import de TYPE, effacé à la compilation.
 */

/**
 * Poids des signaux. Ils sont ADDITIFS et plafonnés : un message qui pose une question ET
 * fixe une échéance compte plus qu'un message qui ne fait que l'un des deux, sans qu'un seul
 * message truffé de mots-clés puisse éclipser tout le reste.
 */
/**
 * ⚠️ BORDS DE MOT EN `\p{L}` AVEC LE DRAPEAU `u`, JAMAIS `\b`.
 *
 * C'est la TROISIÈME fois que ce piège est rencontré dans ce dépôt, et la première où il est
 * corrigé à la racine plutôt qu'au cas par cas. Sans le drapeau `u`, `\b` raisonne en ASCII :
 * `é` n'y est pas une lettre, donc la position entre `é` et `,` n'est pas une frontière et
 * **`/\bbloqué\b/` ne matche JAMAIS** — pas plus que `cassé`, `décidé`, `validé`, `noté` ou
 * `échéance`. Un motif qui échoue en silence sur la moitié du vocabulaire français est pire
 * qu'un motif absent : il donne l'illusion d'une couverture.
 *
 * Rencontré auparavant sur `matchesKeyword` (bords des deux côtés, 2026-08-11) et sur
 * `EXPERTISE_QUESTION_PATTERN` (« à qui », 2026-08-14).
 */
// `alternatives` n'est appelé qu'avec les littéraux de `SIGNALS`, ci-dessous : aucune
// entrée externe n'atteint ce constructeur.
const word = (alternatives: string): RegExp =>
  // eslint-disable-next-line security/detect-non-literal-regexp
  new RegExp(`(?<![\\p{L}])(?:${alternatives})(?![\\p{L}])`, 'iu');

const SIGNALS: ReadonlyArray<{ readonly weight: number; readonly test: RegExp }> = [
  // Une DÉCISION est ce qu'on cherche en premier dans un historique : c'est le seul type de
  // message dont l'absence rend tous les autres incompréhensibles.
  {
    weight: 5,
    test: word(
      "on part sur|on a décidé|on décide|c'est acté|c’est acté|c'est validé|c’est validé|validé|go pour|on retient|décision",
    ),
  },
  // Un ENGAGEMENT nomme un responsable — l'information la plus recherchée après une décision.
  {
    weight: 4,
    test: word(
      "je m'en occupe|je m’en occupe|je prends|je m'en charge|je m’en charge|je fais|je gère|c'est moi qui|c’est moi qui",
    ),
  },
  // Un BLOCAGE appelle une action et périme vite : le rater coûte plus cher que de le montrer.
  { weight: 4, test: word('bloqué|bloquant|problème|panne|urgent|cassé|down|incident|erreur') },
  // Une ÉCHÉANCE date la suite. Les jours de la semaine sont inclus : « on livre jeudi » est
  // une échéance, même sans le mot.
  {
    weight: 3,
    test: word(
      "avant le|d'ici|d’ici|deadline|échéance|au plus tard|lundi|mardi|mercredi|jeudi|vendredi",
    ),
  },
  // Une QUESTION signale un fil ouvert — donc quelque chose qui n'est peut-être pas résolu.
  { weight: 2, test: /\?\s*$/ },
  // Une MENTION assigne à quelqu'un.
  { weight: 2, test: /<@[UW][A-Z0-9]{2,}>/i },
  // Un LIEN pointe un artefact — document, ticket, PR.
  { weight: 1, test: /https?:\/\//i },
];

/** Un seul message ne doit pas rafler la sélection à lui seul. */
const MAX_SIGNAL_SCORE = 12;

/**
 * Les ACCUSÉS DE RÉCEPTION, et rien d'autre.
 *
 * ⚠️ Le motif est ancré des deux bouts : il ne doit attraper QUE les messages qui se réduisent
 * à un acquiescement. « ok pour moi, mais on décale à jeudi » porte une décision et ne doit
 * pas être pénalisé — c'est exactement le genre de message qu'on cherche.
 */
const ACKNOWLEDGEMENT =
  /^(?:ok|okay|d'accord|daccord|merci|parfait|top|noté|note|oui|non|nickel|super|👍|👌|✅|\p{Emoji_Presentation})[\s!.…]*$/iu;

const ACKNOWLEDGEMENT_PENALTY = 6;

/**
 * En dessous, un message n'a pas de contenu propre — il réagit. Le seuil est bas à dessein :
 * « c'est mort » fait 11 caractères et dit quelque chose.
 */
const SHORT_MESSAGE_CHARS = 12;
const SHORT_MESSAGE_PENALTY = 2;

/**
 * Poids de la RÉCENCE, exprimé en points par tranche de rang.
 *
 * La récence reste un signal fort — « quoi de neuf ? » est la question la plus fréquente — mais
 * elle ne doit plus être le SEUL. Le message le plus récent part avec {@link RECENCY_WEIGHT}
 * points d'avance sur le plus ancien de la fenêtre, ce qui départage à saillance égale sans
 * pouvoir écraser une décision plus ancienne.
 */
const RECENCY_WEIGHT = 4;

export function signalScore(text: string): number {
  const raw = text.trim();
  if (raw.length === 0) return 0;

  let score = 0;
  for (const signal of SIGNALS) {
    if (signal.test.test(raw)) score += signal.weight;
  }
  score = Math.min(score, MAX_SIGNAL_SCORE);

  if (ACKNOWLEDGEMENT.test(raw)) score -= ACKNOWLEDGEMENT_PENALTY;
  if (raw.length < SHORT_MESSAGE_CHARS) score -= SHORT_MESSAGE_PENALTY;

  return score;
}

/**
 * Score total d'un extrait dans SA fenêtre.
 *
 * `rank` est la position par ancienneté (0 = le plus ancien), `total` la taille de la fenêtre.
 * La récence est calculée en RANG et non en durée : un canal actif sur une heure et un canal
 * calme sur trois semaines doivent se comporter pareil, or une décroissance temporelle rendrait
 * le second entièrement plat.
 */
export function excerptScore(excerpt: ConversationExcerpt, rank: number, total: number): number {
  const recency = total <= 1 ? RECENCY_WEIGHT : (rank / (total - 1)) * RECENCY_WEIGHT;
  return signalScore(excerpt.text) + recency;
}

/**
 * Sélectionne les extraits les plus PORTEURS, rendus dans l'ordre chronologique.
 *
 * Les deux moitiés sont nécessaires, et c'est l'acquis du module voisin : rendre par score
 * décroissant donnerait au modèle une conversation dans le désordre, où chaque réponse
 * précède sa question.
 *
 * ⚠️ Tri TOTAL et stable : à score égal on départage sur la date puis sur le texte. Sans cela,
 * deux appels identiques peuvent rendre deux sélections différentes — le défaut relevé sur
 * `getNotificationHistory`, qui n'avait aucun `ORDER BY`.
 */
export function selectSalientExcerpts(
  all: readonly ConversationExcerpt[],
  max: number,
): ConversationExcerpt[] {
  if (all.length === 0) return [];

  const chronological = [...all].sort((a, b) => {
    const byDate = a.at.getTime() - b.at.getTime();
    return byDate !== 0 ? byDate : a.text.localeCompare(b.text);
  });

  const scored = chronological.map((excerpt, rank) => ({
    excerpt,
    rank,
    score: excerptScore(excerpt, rank, chronological.length),
  }));

  const best = [...scored].sort((a, b) => {
    const byScore = b.score - a.score;
    if (byScore !== 0) return byScore;
    return b.rank - a.rank;
  });

  const keptRanks = new Set(best.slice(0, max).map((entry) => entry.rank));
  return scored.filter((entry) => keptRanks.has(entry.rank)).map((entry) => entry.excerpt);
}

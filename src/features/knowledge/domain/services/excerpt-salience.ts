import type { ConversationExcerpt } from '../entities/conversation-excerpt';

const word = (alternatives: string): RegExp =>
  // eslint-disable-next-line security/detect-non-literal-regexp
  new RegExp(`(?<![\\p{L}])(?:${alternatives})(?![\\p{L}])`, 'iu');

const SIGNALS: ReadonlyArray<{ readonly weight: number; readonly test: RegExp }> = [
  {
    weight: 5,
    test: word(
      "on part sur|on a décidé|on décide|c'est acté|c’est acté|c'est validé|c’est validé|validé|go pour|on retient|décision",
    ),
  },
  {
    weight: 4,
    test: word(
      "je m'en occupe|je m’en occupe|je prends|je m'en charge|je m’en charge|je fais|je gère|c'est moi qui|c’est moi qui",
    ),
  },
  { weight: 4, test: word('bloqué|bloquant|problème|panne|urgent|cassé|down|incident|erreur') },
  {
    weight: 3,
    test: word(
      "avant le|d'ici|d’ici|deadline|échéance|au plus tard|lundi|mardi|mercredi|jeudi|vendredi",
    ),
  },
  { weight: 2, test: /\?\s*$/ },
  { weight: 2, test: /<@[UW][A-Z0-9]{2,}>/i },
  { weight: 1, test: /https?:\/\//i },
];

const MAX_SIGNAL_SCORE = 12;

const ACKNOWLEDGEMENT =
  /^(?:ok|okay|d'accord|daccord|merci|parfait|top|noté|note|oui|non|nickel|super|👍|👌|✅|\p{Emoji_Presentation})[\s!.…]*$/iu;

const ACKNOWLEDGEMENT_PENALTY = 6;

const SHORT_MESSAGE_CHARS = 12;
const SHORT_MESSAGE_PENALTY = 2;

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

export function excerptScore(excerpt: ConversationExcerpt, rank: number, total: number): number {
  const recency = total <= 1 ? RECENCY_WEIGHT : (rank / (total - 1)) * RECENCY_WEIGHT;
  return signalScore(excerpt.text) + recency;
}

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

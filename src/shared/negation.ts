export const NEGATION_WINDOW_WORDS = 4;

export function isNegatedNear(
  words: readonly string[],
  verbIndex: number,
  negations: ReadonlySet<string>,
  window: number = NEGATION_WINDOW_WORDS,
): boolean {
  const from = Math.max(0, verbIndex - window);
  const to = Math.min(words.length, verbIndex + window + 1);

  for (let i = from; i < to; i += 1) {
    if (i !== verbIndex && negations.has(words[i]!)) return true;
  }

  return false;
}

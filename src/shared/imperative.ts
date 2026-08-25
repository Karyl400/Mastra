export const REQUEST_MARKERS: readonly string[] = [
  'peux tu',
  'tu peux',
  'pourrais tu',
  'tu pourrais',
  'merci de',
  'veux que',
  'aimerais que',
  'faut que',
  'please',
];

export const REQUEST_LOOKBACK_WORDS = 3;

export function isAnOrder(
  words: readonly string[],
  verbIndex: number,
  lookback: number = REQUEST_LOOKBACK_WORDS,
): boolean {
  if (verbIndex === 0) return true;

  const before = words.slice(Math.max(0, verbIndex - lookback), verbIndex).join(' ');
  return REQUEST_MARKERS.some((marker) => before.includes(marker));
}

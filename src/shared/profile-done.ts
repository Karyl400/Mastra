function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[’´`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const MAX_CHARS = 48;

const DONE_PATTERNS: readonly RegExp[] = [
  /^(?:c'est|cest) (?:fait|bon|termine|fini|complete)\b/,
  /^j'?ai (?:fini|termine|complete|rempli)\b/,
  /^voila,? (?:c'est )?fini\b/,
  /^(?:je l'ai|je viens de le) (?:fait|faite|rempli|complete)\b/,
  /^(?:profil|dossier|formulaire) (?:complete|rempli|fait|termine)\b/,
  /^(?:fait|termine)\s*!*$/,
  /^(?:ok|okay|voila|bon),? ?(?:c'est|cest) (?:fait|bon|termine|fini|pret|complete)\b/,
  /^(?:c'est|cest) pret\b/,
  /^ca y est\b/,
];

const NEGATION =
  /\bn(?:e |')(?:ai|est|arrive)|\bpas (?:encore )?(?:fini|termine|fait)|\bpas fini\b/;

export function claimsProfileDone(text: string | undefined | null): boolean {
  const normalized = normalize(text ?? '');
  if (!normalized || normalized.length > MAX_CHARS) return false;
  if (NEGATION.test(normalized)) return false;
  return DONE_PATTERNS.some((pattern) => pattern.test(normalized));
}

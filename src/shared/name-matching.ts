export function normalizeName(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function nameTokens(raw: string | null | undefined): string[] {
  const normalized = normalizeName(raw);
  if (!normalized) return [];
  return normalized.split(/[\s-]+/).filter((token) => token.length > 0);
}

export function matchesName(
  query: string | null | undefined,
  candidateFields: ReadonlyArray<string | null | undefined>,
): boolean {
  const queryTokens = nameTokens(query);
  if (queryTokens.length === 0) return false;

  const candidateTokens = candidateFields.flatMap((field) => nameTokens(field));
  if (candidateTokens.length === 0) return false;

  return queryTokens.every((wanted) =>
    candidateTokens.some((candidate) => candidate.startsWith(wanted)),
  );
}

export function fullName(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
): string {
  return [firstName, lastName]
    .map((part) => part?.trim() ?? '')
    .filter(Boolean)
    .join(' ');
}

export function textMentionsName(
  text: string | null | undefined,
  name: string | null | undefined,
): boolean {
  const wanted = nameTokens(name).filter((token) => token.length >= 3);
  if (wanted.length === 0) return false;

  const words = new Set(
    normalizeName(text)
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );

  return wanted.some((token) => words.has(token));
}

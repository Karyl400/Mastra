export const FTS_MAX_TERMS = 8;

const TERM = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

const MIN_TERM_CHARS = 2;

export function toMatchQuery(raw: string): string | null {
  const terms: string[] = [];

  for (const match of raw.matchAll(TERM)) {
    const term = match[0];
    if (term.length < MIN_TERM_CHARS) continue;
    terms.push(`"${term.replaceAll('"', '""')}"`);
    if (terms.length === FTS_MAX_TERMS) break;
  }

  return terms.length === 0 ? null : terms.join(' OR ');
}

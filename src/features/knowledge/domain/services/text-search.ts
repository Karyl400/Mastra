import { FTS_MAX_TERMS } from './fts-query';

const TERM = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

const MIN_TERM_CHARS = 2;

export function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase();
}

export function queryTerms(raw: string): string[] {
  const terms: string[] = [];

  for (const match of fold(raw).matchAll(TERM)) {
    if (match[0].length < MIN_TERM_CHARS) continue;
    terms.push(match[0]);
    if (terms.length === FTS_MAX_TERMS) break;
  }

  return terms;
}

export function matchedTermCount(haystack: string, query: string): number {
  const folded = fold(haystack);
  return queryTerms(query).filter((term) => folded.includes(term)).length;
}

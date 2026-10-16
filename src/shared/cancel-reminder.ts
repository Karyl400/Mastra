export type { CancellableReminder } from './cancel-reminder-scope';
export * from './cancel-reminder-replies';

import type { CancellableReminder } from './cancel-reminder-scope';
import { normalizeIntentText } from './intent-text';
import { isNegatedNear } from './negation';
import { isAnOrder } from './imperative';

export type CancelReminderScope = 'last' | 'all';

const CANCEL_STEMS: readonly string[] = [
  'annul',
  'supprim',
  'efface',
  'retire',
  'retirer',
  'enleve',
  'enlever',
  'oubli',
  'cancel',
];

const REMINDER_WORDS: ReadonlySet<string> = new Set(['rappel', 'rappels', 'relance', 'relances']);

const PLURAL_WORDS: ReadonlySet<string> = new Set(['rappels', 'relances']);

const EVERY_WORDS: ReadonlySet<string> = new Set(['tous', 'toutes']);

const NEGATIONS: ReadonlySet<string> = new Set([
  'ne',
  'n',
  'pas',
  'sans',
  'jamais',
  'aucun',
  'aucune',
  'rien',
  'never',
  'dont',
]);

const MAX_CANCEL_LENGTH = 200;

function isCancelVerb(word: string): boolean {
  return CANCEL_STEMS.some((stem) => word.startsWith(stem));
}

export function requestsReminderCancellation(
  text: string | undefined | null,
): CancelReminderScope | null {
  const raw = (text ?? '').trim();
  if (raw.length === 0 || raw.length > MAX_CANCEL_LENGTH) return null;

  const words = normalizeIntentText(raw).split(' ');

  const objects = words.filter((word) => REMINDER_WORDS.has(word));
  if (objects.length === 0) return null;

  const ordered = words.some(
    (word, index) =>
      isCancelVerb(word) && isAnOrder(words, index) && !isNegatedNear(words, index, NEGATIONS),
  );
  if (!ordered) return null;

  const every =
    objects.some((word) => PLURAL_WORDS.has(word)) || words.some((word) => EVERY_WORDS.has(word));

  return every ? 'all' : 'last';
}

const DESIGNATION_STOPWORDS: ReadonlySet<string> = new Set([
  'les',
  'mes',
  'mon',
  'ceux',
  'cet',
  'cette',
  'celui',
  'celle',
  'des',
  'une',
  'pour',
  'aux',
  'sur',
  'que',
  'qui',
  'est',
  'stp',
  'svp',
  'merci',
  'prevu',
  'prevue',
  'tous',
  'toutes',
  'tout',
]);

const MIN_DESIGNATION_LENGTH = 3;

const DIGITS = /^\d+$/;

function isDistinctive(word: string): boolean {
  if (REMINDER_WORDS.has(word) || isCancelVerb(word)) return false;
  if (DIGITS.test(word)) return true;
  return word.length >= MIN_DESIGNATION_LENGTH && !DESIGNATION_STOPWORDS.has(word);
}

function designationWords(text: string): string[] {
  return normalizeIntentText(text).split(' ').filter(isDistinctive);
}

function haystackOf(candidate: CancellableReminder): ReadonlySet<string> {
  return new Set(
    normalizeIntentText(`${candidate.deliveredOn ?? ''} ${candidate.subject}`).split(' '),
  );
}

export type ReminderPick<T extends CancellableReminder> =
  { readonly chosen: T } | { readonly ambiguous: readonly T[] };

export function pickReminderToCancel<T extends CancellableReminder>(
  candidates: readonly T[],
  text: string,
): ReminderPick<T> {
  if (candidates.length === 1) return { chosen: candidates[0]! };
  if (candidates.length === 0) return { ambiguous: [] };

  const wanted = designationWords(text);
  if (wanted.length === 0) return { ambiguous: candidates };

  const haystacks = candidates.map(haystackOf);
  const scores = haystacks.map((haystack) => wanted.filter((word) => haystack.has(word)).length);

  const best = Math.max(...scores);
  if (best === 0) return { ambiguous: candidates };

  const winners = scores.reduce<number[]>(
    (kept, score, index) => (score === best ? [...kept, index] : kept),
    [],
  );
  if (winners.length !== 1) return { ambiguous: candidates };

  return { chosen: candidates[winners[0]!]! };
}

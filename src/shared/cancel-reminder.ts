import { normalizeIntentText } from './intent-text';
import { isNegatedNear } from './negation';
import { isAnOrder } from './imperative';
import { ESCALATION_CONTACT } from './escalation';

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

export interface CancellableReminder {
  readonly subject: string;
  readonly deliveredOn: string | null;
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

export function reminderCancelledReply(subject: string, deliveredOn: string | null): string {
  const when = deliveredOn ? ` Il ne partira pas ${deliveredOn}.` : ' Il ne partira pas.';
  return `C'est annulé : « ${subject} ».${when}`;
}

export function remindersCancelledReply(count: number, asked: number = count): string {
  const noun = count > 1 ? 'rappels' : 'rappel';
  const head = `C'est annulé : ${count} ${noun} en attente, plus aucun ne partira.`;

  const missed = asked - count;
  if (missed <= 0) return head;

  const tail =
    missed > 1
      ? ` ${missed} autres étaient déjà en cours de remise, je n'ai pas pu les arrêter.`
      : " Un autre était déjà en cours de remise, je n'ai pas pu l'arrêter.";
  return head + tail;
}

export function reminderCancelChoiceReply(candidates: readonly CancellableReminder[]): string {
  const lines = candidates
    .map(({ subject, deliveredOn }) =>
      deliveredOn ? `• ${deliveredOn} — « ${subject} »` : `• « ${subject} »`,
    )
    .join('\n');

  return (
    'Tu as plusieurs rappels en attente, et je ne veux pas deviner lequel :\n' +
    `${lines}\n` +
    'Dis-moi lequel, ou demande-moi de les annuler tous.'
  );
}

export const NO_REMINDER_TO_CANCEL_REPLY =
  "Tu n'as aucun rappel en attente — il n'y a rien à annuler.";

export const REMINDER_ALREADY_SENT_REPLY =
  "Ce rappel est déjà en cours de remise, je ne peux plus l'arrêter. Il va donc arriver — " +
  'excuse-moi pour le bruit.';

export const REMINDER_CANCEL_FAILED_REPLY =
  "Je n'ai pas réussi à annuler ce rappel — ma base est indisponible à l'instant. Redemande-le" +
  ` dans un moment, ou signale-le à ${ESCALATION_CONTACT}.`;

export const REMINDER_CANCEL_NO_RECORD_REPLY =
  'Je ne retrouve pas de dossier à ton nom, donc je ne sais pas de quels rappels tu parles. ' +
  'Dis-moi « je veux compléter mon profil » et on règle ça.';

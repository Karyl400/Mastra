import type { ConversationExcerpt } from '../entities/conversation-excerpt';
import { selectSalientExcerpts } from './excerpt-salience';
import { resolveMentions, type NameLookup } from './mention-names';
import { frenchDaySpan } from '../../../../shared/french-datetime';

export const MAX_EXCERPTS = 6;

export const EXCERPT_MAX_CHARS = 180;

export const SPEAKER_MAX_CHARS = 24;

const ELLIPSIS = '…';

function flatten(value: string, maxChars: number): string {
  const withoutControls = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/[<>]/g, '');

  const compacted = withoutControls.replace(/\s+/g, ' ').trim();

  return compacted.length > maxChars ? `${compacted.slice(0, maxChars)}${ELLIPSIS}` : compacted;
}

function formatStamp(at: Date): string {
  const iso = new Date(at.getTime()).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

export function renderExcerptLines(excerpts: readonly ConversationExcerpt[]): string {
  return excerpts
    .map((excerpt) => {
      const speaker = flatten(excerpt.speaker, SPEAKER_MAX_CHARS) || '?';
      const text = flatten(excerpt.text, EXCERPT_MAX_CHARS);
      return `[${formatStamp(excerpt.at)}] ${speaker}: ${text}`;
    })
    .join('\n');
}

export function projectExcerpts(
  all: readonly ConversationExcerpt[],
  lookup?: NameLookup,
): {
  lines: string;
  shown: number;
  coverage?: string;
} {
  const selected = selectSalientExcerpts(all, MAX_EXCERPTS);
  const readable = lookup
    ? selected.map((excerpt) => ({ ...excerpt, text: resolveMentions(excerpt.text, lookup) }))
    : selected;

  return {
    lines: renderExcerptLines(readable),
    shown: selected.length,
    coverage: describeCoverage(all, selected.length),
  };
}

export function describeCoverage(
  all: readonly ConversationExcerpt[],
  shown: number,
): string | undefined {
  if (all.length === 0 || shown >= all.length) return undefined;

  const stamps = all.map((excerpt) => excerpt.at.getTime()).sort((a, b) => a - b);
  const from = new Date(stamps[0]!).toISOString().slice(0, 10);
  const to = new Date(stamps[stamps.length - 1]!).toISOString().slice(0, 10);
  const span = from === to ? `le ${from}` : `du ${from} au ${to}`;

  return `${shown} extraits retenus sur ${all.length} messages, ${span} — les plus porteurs d'information, PAS les plus récents. Ne conclus pas que rien d'autre n'a été dit.`;
}

export function describeCoverageForHuman(
  all: readonly ConversationExcerpt[],
  shown: number,
): string | undefined {
  if (all.length === 0 || shown >= all.length) return undefined;

  const stamps = all.map((excerpt) => excerpt.at.getTime()).sort((a, b) => a - b);
  const span = frenchDaySpan(new Date(stamps[0]!), new Date(stamps[stamps.length - 1]!));

  return `_Je n'ai lu que ${shown} messages sur ${all.length}, ${span} — les plus porteurs d'information, pas les plus récents. D'autres choses ont pu être dites._`;
}

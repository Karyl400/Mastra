import type { ConversationExcerpt } from '../entities/conversation-excerpt';
import { selectSalientExcerpts } from './excerpt-salience';
import { resolveMentions, type NameLookup } from './mention-names';

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

/**
 * ⚠️ **LE `lookup` RÉSOUT LES MENTIONS, ET IL EST POSÉ ICI PLUTÔT QUE CHEZ LES APPELANTS.**
 *
 * Deux outils projettent des extraits vers le modèle (`getChannelHistory`,
 * `getUserConversations`) et un troisième les rend autrement (`searchKnowledge`). Résoudre les
 * mentions dans chacun aurait fait trois sites à ne pas oublier — la forme de défaut que ce
 * dépôt paie le plus souvent. Le point de passage OBLIGÉ est cette fonction : elle est la
 * dernière chose que traverse un extrait avant de devenir du texte.
 *
 * Optionnel à dessein : sans annuaire, on rend exactement ce qu'on rendait avant, jetons bruts
 * compris. Une dégradation lisible, jamais une invention.
 */
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
  const from = new Date(stamps[0]!).toISOString().slice(0, 10);
  const to = new Date(stamps[stamps.length - 1]!).toISOString().slice(0, 10);
  const span = from === to ? `le ${from}` : `du ${from} au ${to}`;

  return `_Je n'ai lu que ${shown} messages sur ${all.length}, ${span} — les plus porteurs d'information, pas les plus récents. D'autres choses ont pu être dites._`;
}

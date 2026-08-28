import { logger } from '../../../../shared/logger';
import type { ChannelHistoryPort } from '../../domain/ports/channel-history.port';
import { isDirectMessageChannel } from '../../domain/ports/message-archive.repository';
import type { PersonDirectoryPort } from '../../domain/ports/person-directory.port';
import type { FactKind } from '../../domain/services/fact-distillation';
import { matchedTermCount } from '../../domain/services/text-search';

export const MAX_CHANNELS_CHECKED = 6;

export const SCAN_LIMIT = 24;

const LIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const LIVE_SCAN_LIMIT = 60;

export interface Line {
  readonly channelId: string;
  readonly slackUserId: string | null;
  readonly postedAt: number;
  readonly kind: FactKind | null;
  readonly text: string;
}

export async function resolveSpeakers(
  directory: PersonDirectoryPort,
  lines: readonly Line[],
): Promise<Map<string, string>> {
  const ids = [...new Set(lines.map((l) => l.slackUserId).filter((id): id is string => !!id))];

  const resolved = await Promise.all(
    ids.map(async (id) => {
      try {
        const person = await directory.findBySlackUserId(id);
        return [id, person?.displayName?.trim() || id] as const;
      } catch {
        return [id, id] as const;
      }
    }),
  );

  return new Map(resolved);
}

export async function readableChannels(
  channels: ChannelHistoryPort,
  channelIds: readonly string[],
  requesterId: string,
  isManager: boolean,
): Promise<Set<string>> {
  const distinct = [...new Set(channelIds)].slice(0, MAX_CHANNELS_CHECKED);

  const verdicts = await Promise.all(
    distinct.map(async (channelId) => {
      if (isDirectMessageChannel(channelId)) {
        const own = await channels.isMember(channelId, requesterId).catch(() => false as boolean);
        return [channelId, own || isManager] as const;
      }

      try {
        return [channelId, await channels.isMember(channelId, requesterId)] as const;
      } catch (error) {
        logger.warn('Knowledge — appartenance indécidable, canal écarté de la recherche', {
          channelId,
          error,
        });
        return [channelId, false] as const;
      }
    }),
  );

  return new Set(verdicts.filter(([, member]) => member).map(([channelId]) => channelId));
}

export async function sweepLive(
  channels: ChannelHistoryPort,
  query: string,
  requesterId: string,
  only?: string,
): Promise<Line[]> {
  const channelIds = only
    ? [only]
    : (await channels.listMemberChannels(requesterId, MAX_CHANNELS_CHECKED)).map(
        (channel) => channel.id,
      );

  if (channelIds.length === 0) return [];

  const readable = only ? await readableChannels(channels, [only], requesterId, false) : null;
  const targets = readable ? channelIds.filter((id) => readable.has(id)) : channelIds;

  const perChannel = await Promise.all(
    targets.map((channelId) => sweepOneChannel(channels, channelId, query)),
  );

  return perChannel
    .flat()
    .sort((a, b) => b.postedAt - a.postedAt)
    .slice(0, SCAN_LIMIT);
}

async function sweepOneChannel(
  channels: ChannelHistoryPort,
  channelId: string,
  query: string,
): Promise<Line[]> {
  try {
    const messages = await channels.fetchRecent(channelId, {
      sinceMs: LIVE_WINDOW_MS,
      limit: LIVE_SCAN_LIMIT,
    });

    return messages
      .filter((message) => !message.isBot && matchedTermCount(message.text, query) > 0)
      .map<Line>((message) => ({
        channelId,
        slackUserId: message.authorId,
        postedAt: message.at.getTime(),
        kind: null,
        text: message.text,
      }));
  } catch (error) {
    logger.warn('Knowledge — canal illisible pendant la lecture en direct', {
      channelId,
      error: String(error),
    });
    return [];
  }
}

const COVERAGE_SOURCES: Readonly<Record<string, string>> = {
  facts: "Ces éléments viennent de ce que j'ai retenu au fil des canaux",
  messages: "Ces éléments sont des messages bruts d'archive",
  live: 'Ces éléments viennent de canaux que je viens de relire à l’instant, sur le dernier mois',
};

export function describeSearchCoverage(shown: number, matched: number, tier: string): string {
  const source = COVERAGE_SOURCES[tier] ?? COVERAGE_SOURCES.messages;

  const truncation = matched > shown ? ` sur ${matched} correspondances` : '';

  return `${source}${truncation} — PAS une lecture exhaustive. Ne conclus pas que rien d'autre n'a été dit.`;
}

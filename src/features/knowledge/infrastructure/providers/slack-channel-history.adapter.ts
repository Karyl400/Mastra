import { WebClient } from '@slack/web-api';

import { logger } from '../../../../shared/logger';
import { slackErrorCode } from '../../../../shared/slack/slack-error';
import {
  ChannelUnavailableError,
  type ChannelHistoryPort,
  type ChannelHistoryReadOptions,
  type ChannelMessage,
  type ChannelRef,
  type ChannelUnavailableReason,
} from '../../domain/ports/channel-history.port';

const MEMBER_PAGE_SIZE = 1000;
const MAX_MEMBER_PAGES = 5;

export type DisplayNameResolver = (slackUserId: string) => Promise<string | null>;

export interface SlackChannelHistoryOptions {
  readonly client?: WebClient;
  readonly resolveDisplayName?: DisplayNameResolver;
}

function toUnprovable(error: unknown, channelId: string): ChannelUnavailableError {
  const code = slackErrorCode(error);

  if (code === 'channel_not_found') {
    return new ChannelUnavailableError(
      'channel_not_found',
      `Aucun canal visible sous ${channelId} (${code})`,
      { cause: error },
    );
  }

  const detail = code ? ` (${code})` : '';
  return new ChannelUnavailableError(
    'unavailable',
    `Appartenance non vérifiable sur ${channelId}${detail}`,
    { cause: error },
  );
}

function toUnavailable(error: unknown, channelId: string): ChannelUnavailableError {
  const code = slackErrorCode(error);

  if (code === 'not_in_channel' || code === 'missing_scope' || code === 'channel_not_found') {
    const reason: ChannelUnavailableReason = 'bot_not_in_channel';
    return new ChannelUnavailableError(
      reason,
      `Slack a refusé la lecture de ${channelId} (${code})`,
      { cause: error },
    );
  }

  return new ChannelUnavailableError('unavailable', `Slack indisponible pour ${channelId}`, {
    cause: error,
  });
}

export class SlackChannelHistoryAdapter implements ChannelHistoryPort {
  private readonly slack: WebClient;
  private readonly resolveDisplayName?: DisplayNameResolver;

  constructor(botToken: string, options: SlackChannelHistoryOptions = {}) {
    this.slack = options.client ?? new WebClient(botToken);
    this.resolveDisplayName = options.resolveDisplayName;
  }

  async isMember(channelId: string, slackUserId: string): Promise<boolean> {
    let cursor: string | undefined;

    try {
      for (let page = 0; page < MAX_MEMBER_PAGES; page++) {
        const response = await this.slack.conversations.members({
          channel: channelId,
          limit: MEMBER_PAGE_SIZE,
          cursor,
        });

        const members = Array.isArray(response.members) ? response.members : [];
        if (members.includes(slackUserId)) return true;

        cursor = response.response_metadata?.next_cursor || undefined;
        if (!cursor) return false;
      }

      logger.warn('Knowledge — canal trop grand pour vérifier l’appartenance', {
        channelId,
        pages: MAX_MEMBER_PAGES,
      });
      throw new ChannelUnavailableError(
        'unavailable',
        `Appartenance non vérifiable sur ${channelId} (canal trop grand)`,
      );
    } catch (error) {
      if (error instanceof ChannelUnavailableError) throw error;

      logger.warn('Knowledge — conversations.members a échoué, appartenance non prouvée', {
        channelId,
        slackError: slackErrorCode(error),
      });
      throw toUnprovable(error, channelId);
    }
  }

  async listMemberChannels(slackUserId: string, limit: number): Promise<ChannelRef[]> {
    try {
      const response = await this.slack.users.conversations({
        user: slackUserId,
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit,
      });

      const channels = Array.isArray(response.channels) ? response.channels : [];
      return channels
        .map((channel) => channel as { id?: unknown; name?: unknown })
        .filter(
          (channel): channel is { id: string; name?: unknown } => typeof channel.id === 'string',
        )
        .map((channel) => ({
          id: channel.id,
          name: typeof channel.name === 'string' ? channel.name : '',
        }))
        .slice(0, limit);
    } catch (error) {
      logger.warn('Knowledge — users.conversations a échoué, pas de lecture en direct', {
        slackUserId,
        slackError: slackErrorCode(error),
      });
      return [];
    }
  }

  async fetchRecent(
    channelId: string,
    options: ChannelHistoryReadOptions,
  ): Promise<ChannelMessage[]> {
    const oldest = ((Date.now() - options.sinceMs) / 1000).toFixed(6);

    let messages: unknown[];
    try {
      const response = await this.slack.conversations.history({
        channel: channelId,
        limit: options.limit,
        oldest,
        inclusive: false,
      });
      messages = Array.isArray(response.messages) ? response.messages : [];
    } catch (error) {
      throw toUnavailable(error, channelId);
    }

    const raw = messages
      .map((message) => this.toRawMessage(message))
      .filter((message): message is RawChannelMessage => message !== null);

    return this.withLabels(raw);
  }

  private toRawMessage(message: unknown): RawChannelMessage | null {
    if (typeof message !== 'object' || message === null) return null;

    const record = message as {
      type?: unknown;
      subtype?: unknown;
      text?: unknown;
      user?: unknown;
      bot_id?: unknown;
      ts?: unknown;
    };

    if (record.type !== 'message') return null;
    if (typeof record.subtype === 'string') return null;

    const text = typeof record.text === 'string' ? record.text.trim() : '';
    if (!text) return null;

    const ts = typeof record.ts === 'string' ? Number.parseFloat(record.ts) : Number.NaN;
    if (!Number.isFinite(ts)) return null;

    return {
      authorId: typeof record.user === 'string' ? record.user : null,
      text,
      at: new Date(ts * 1000),
      isBot: typeof record.bot_id === 'string',
    };
  }

  private async withLabels(raw: readonly RawChannelMessage[]): Promise<ChannelMessage[]> {
    const labels = new Map<string, string>();

    if (this.resolveDisplayName) {
      const authorIds = [...new Set(raw.map((m) => m.authorId).filter((id): id is string => !!id))];

      for (const authorId of authorIds) {
        try {
          const name = await this.resolveDisplayName(authorId);
          if (name) labels.set(authorId, name);
        } catch {}
      }
    }

    const labelOf = (message: RawChannelMessage): string => {
      if (message.authorId) return labels.get(message.authorId) ?? message.authorId;
      return message.isBot ? 'Kisso' : '?';
    };

    return raw.map((message) => ({
      authorId: message.authorId,
      authorLabel: labelOf(message),
      text: message.text,
      at: message.at,
      isBot: message.isBot,
    }));
  }
}

interface RawChannelMessage {
  readonly authorId: string | null;
  readonly text: string;
  readonly at: Date;
  readonly isBot: boolean;
}

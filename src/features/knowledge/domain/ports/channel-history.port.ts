export interface ChannelMessage {
  readonly authorId: string | null;
  readonly authorLabel: string;
  readonly text: string;
  readonly at: Date;
  readonly isBot: boolean;
}

export type ChannelUnavailableReason = 'bot_not_in_channel' | 'channel_not_found' | 'unavailable';

export class ChannelUnavailableError extends Error {
  constructor(
    readonly reason: ChannelUnavailableReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ChannelUnavailableError';
  }
}

export interface ChannelHistoryReadOptions {
  readonly sinceMs: number;
  readonly limit: number;
}

export interface ChannelHistoryPort {
  isMember(channelId: string, slackUserId: string): Promise<boolean>;

  fetchRecent(channelId: string, options: ChannelHistoryReadOptions): Promise<ChannelMessage[]>;
}

export interface ArchivedMessage {
  readonly id: string;
  readonly channelId: string;
  readonly slackUserId: string | null;
  readonly text: string;
  readonly threadTs: string | null;
  readonly postedAt: number;
}

export interface MessageArchiveRepository {
  archive(message: ArchivedMessage): Promise<boolean>;
  search(query: string, options?: MessageSearchOptions): Promise<readonly ArchivedMessage[]>;
  forgetUser(slackUserId: string): Promise<number>;
  prune(before: number): Promise<number>;
}

export interface MessageSearchOptions {
  readonly channelId?: string;
  readonly slackUserId?: string;
  readonly limit?: number;
}

export const ARCHIVED_CHANNEL_TYPES: readonly string[] = ['channel', 'group'];

export function isArchivableChannelType(channelType: string | undefined): boolean {
  return channelType !== undefined && ARCHIVED_CHANNEL_TYPES.includes(channelType);
}

export function archiveIdOf(channelId: string, ts: string): string {
  return `${channelId}:${ts}`;
}

export function postedAtOf(ts: string): number {
  const seconds = Number.parseFloat(ts);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
}

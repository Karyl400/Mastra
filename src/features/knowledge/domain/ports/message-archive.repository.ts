export interface ArchivedMessage {
  readonly id: string;
  readonly channelId: string;
  readonly slackUserId: string | null;
  readonly text: string;
  readonly threadTs: string | null;
  readonly postedAt: number;
}

export interface ForgetScope {
  readonly slackUserId: string;
  readonly channelId?: string;
}

export interface MessageArchiveRepository {
  archive(message: ArchivedMessage): Promise<boolean>;
  search(query: string, options?: MessageSearchOptions): Promise<readonly ArchivedMessage[]>;
  forgetUser(scope: ForgetScope): Promise<number>;
  prune(before: number): Promise<number>;

  pendingDistillation(sinceMs: number, limit: number): Promise<readonly ArchivedMessage[]>;

  markDistilled(ids: readonly string[], at: number): Promise<number>;
}

export interface MessageSearchOptions {
  readonly channelId?: string;
  readonly slackUserId?: string;
  readonly limit?: number;
}

export const ARCHIVED_CHANNEL_TYPES: readonly string[] = ['channel', 'group', 'im'];

export function isArchivableChannelType(channelType: string | undefined): boolean {
  return channelType !== undefined && ARCHIVED_CHANNEL_TYPES.includes(channelType);
}

export function isDirectMessageChannel(channelId: string): boolean {
  return /^D/i.test(channelId.trim());
}

export function archiveIdOf(channelId: string, ts: string): string {
  return `${channelId}:${ts}`;
}

export function postedAtOf(ts: string): number {
  const seconds = Number.parseFloat(ts);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
}

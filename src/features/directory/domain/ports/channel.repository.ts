import type {
  SlackChannelFacts,
  SlackChannelInventoryEntry,
  SlackChannelMembership,
  SlackChannelRecord,
} from '../entities/slack-channel';

export interface ChannelInventoryRepository {
  upsertChannel(facts: SlackChannelFacts, now: Date): Promise<void>;

  replaceMembers(channelId: string, slackUserIds: readonly string[], now: Date): Promise<void>;

  listChannels(): Promise<SlackChannelRecord[]>;

  listInventory(): Promise<SlackChannelInventoryEntry[]>;

  listObservedMembers(channelId: string): Promise<SlackChannelMembership[]>;

  listChannelsObservedForUser(slackUserId: string): Promise<SlackChannelMembership[]>;
}

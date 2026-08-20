import type {
  SlackChannelFacts,
  SlackChannelInventoryEntry,
  SlackChannelMembership,
  SlackChannelRecord,
} from '../../domain/entities/slack-channel';
import type { ChannelInventoryRepository } from '../../domain/ports/channel.repository';

export class InMemoryChannelInventoryRepository implements ChannelInventoryRepository {
  private channels = new Map<string, SlackChannelRecord>();
  private members = new Map<string, Map<string, SlackChannelMembership>>();

  async upsertChannel(facts: SlackChannelFacts, now: Date): Promise<void> {
    this.channels.set(facts.channelId, {
      channelId: facts.channelId,
      name: facts.name,
      isPrivate: facts.isPrivate,
      isArchived: facts.isArchived,
      isMember: facts.isMember,
      memberCountReported: facts.memberCountReported,
      syncedAt: now,
    });
  }

  async replaceMembers(
    channelId: string,
    slackUserIds: readonly string[],
    now: Date,
  ): Promise<void> {
    const previous = this.members.get(channelId) ?? new Map<string, SlackChannelMembership>();
    const next = new Map<string, SlackChannelMembership>();

    for (const slackUserId of new Set(slackUserIds)) {
      next.set(slackUserId, {
        channelId,
        slackUserId,
        firstSeenAt: previous.get(slackUserId)?.firstSeenAt ?? now,
        syncedAt: now,
      });
    }

    this.members.set(channelId, next);
  }

  async listChannels(): Promise<SlackChannelRecord[]> {
    return [...this.channels.values()].sort((a, b) => compareBinary(a.channelId, b.channelId));
  }

  async listInventory(): Promise<SlackChannelInventoryEntry[]> {
    const channels = await this.listChannels();
    return channels.map((channel) => ({
      channel,
      observedMemberCount: this.members.get(channel.channelId)?.size ?? 0,
    }));
  }

  async listObservedMembers(channelId: string): Promise<SlackChannelMembership[]> {
    const rows = [...(this.members.get(channelId)?.values() ?? [])];
    return rows.sort((a, b) => compareBinary(a.slackUserId, b.slackUserId));
  }

  async listChannelsObservedForUser(slackUserId: string): Promise<SlackChannelMembership[]> {
    const rows: SlackChannelMembership[] = [];
    for (const byUser of this.members.values()) {
      const hit = byUser.get(slackUserId);
      if (hit) rows.push(hit);
    }
    return rows.sort((a, b) => compareBinary(a.channelId, b.channelId));
  }

  clear(): void {
    this.channels.clear();
    this.members.clear();
  }
}

function compareBinary(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

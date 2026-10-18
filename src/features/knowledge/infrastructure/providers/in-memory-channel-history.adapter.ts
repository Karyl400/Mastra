import {
  ChannelUnavailableError,
  type ChannelHistoryPort,
  type ChannelHistoryReadOptions,
  type ChannelMessage,
  type ChannelRef,
  type ChannelUnavailableReason,
  type VisibleChannels,
  type VisibleChannelsOptions,
} from '../../domain/ports/channel-history.port';

export class InMemoryChannelHistoryAdapter implements ChannelHistoryPort {
  private readonly members = new Map<string, Set<string>>();
  private readonly messages = new Map<string, ChannelMessage[]>();
  private readonly failures = new Map<string, ChannelUnavailableReason>();
  private readonly names = new Map<string, string>();
  private readonly publicChannels = new Set<string>();
  private listingFailure: ChannelUnavailableReason | null = null;

  setMembers(channelId: string, slackUserIds: readonly string[]): void {
    this.members.set(channelId, new Set(slackUserIds));
  }

  markPublic(channelId: string): void {
    this.publicChannels.add(channelId);
  }

  failListing(reason: ChannelUnavailableReason): void {
    this.listingFailure = reason;
  }

  nameChannel(channelId: string, name: string): void {
    this.names.set(channelId, name);
  }

  seed(channelId: string, messages: readonly ChannelMessage[]): void {
    this.messages.set(channelId, [...messages]);
  }

  failWith(channelId: string, reason: ChannelUnavailableReason): void {
    this.failures.set(channelId, reason);
  }

  async isMember(channelId: string, slackUserId: string): Promise<boolean> {
    return this.members.get(channelId)?.has(slackUserId) ?? false;
  }

  async listMemberChannels(slackUserId: string, limit: number): Promise<ChannelRef[]> {
    return [...this.members.entries()]
      .filter(([channelId, ids]) => ids.has(slackUserId) && !/^D/i.test(channelId))
      .map(([channelId]) => ({ id: channelId, name: this.names.get(channelId) ?? '' }))
      .slice(0, limit);
  }

  async listVisibleChannels(
    slackUserId: string,
    options: VisibleChannelsOptions,
  ): Promise<VisibleChannels> {
    if (this.listingFailure) {
      throw new ChannelUnavailableError(this.listingFailure, 'liste des canaux indisponible');
    }

    const mine = await this.listMemberChannels(slackUserId, options.limit);
    const mineIds = new Set(mine.map((channel) => channel.id));

    const others = options.includePublicOthers
      ? [...this.publicChannels]
          .filter((channelId) => !mineIds.has(channelId))
          .map((channelId) => ({ id: channelId, name: this.names.get(channelId) ?? '' }))
          .slice(0, options.limit)
      : [];

    return { mine, others };
  }

  async fetchRecent(
    channelId: string,
    options: ChannelHistoryReadOptions,
  ): Promise<ChannelMessage[]> {
    const failure = this.failures.get(channelId);
    if (failure) {
      throw new ChannelUnavailableError(failure, `canal ${channelId} indisponible (${failure})`);
    }

    const cutoff = Date.now() - options.sinceMs;

    const fresh = (this.messages.get(channelId) ?? []).filter(
      (message) => message.at.getTime() >= cutoff,
    );

    const newestFirst = [...fresh].sort((a, b) => b.at.getTime() - a.at.getTime());

    return newestFirst.slice(0, options.limit).reverse();
  }
}

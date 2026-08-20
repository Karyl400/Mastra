import {
  ChannelUnavailableError,
  type ChannelHistoryPort,
  type ChannelHistoryReadOptions,
  type ChannelMessage,
  type ChannelUnavailableReason,
} from '../../domain/ports/channel-history.port';

export class InMemoryChannelHistoryAdapter implements ChannelHistoryPort {
  private readonly members = new Map<string, Set<string>>();
  private readonly messages = new Map<string, ChannelMessage[]>();
  private readonly failures = new Map<string, ChannelUnavailableReason>();

  setMembers(channelId: string, slackUserIds: readonly string[]): void {
    this.members.set(channelId, new Set(slackUserIds));
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

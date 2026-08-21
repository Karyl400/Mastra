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

  // ⚠️ DÉRIVÉ de `setMembers`, jamais d'une seconde liste : c'est cette doublure qui décide, dans
  // tous les tests, quels canaux la lecture en direct balaie. Deux sources divergeraient, et le
  // test verrouillerait alors une frontière que la production n'applique pas.
  async listMemberChannels(slackUserId: string, limit: number): Promise<string[]> {
    return [...this.members.entries()]
      .filter(([channelId, ids]) => ids.has(slackUserId) && !/^D/i.test(channelId))
      .map(([channelId]) => channelId)
      .slice(0, limit);
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

import type {
  BotMemoryReadOptions,
  BotMemoryReadPort,
  BotMemoryTurn,
} from '../../domain/ports/bot-memory.repository';

export class InMemoryBotMemoryRepository implements BotMemoryReadPort {
  private readonly turns = new Map<string, BotMemoryTurn[]>();

  seed(dmChannelId: string, turns: readonly BotMemoryTurn[]): void {
    this.turns.set(dmChannelId, [...turns]);
  }

  async recentDirectTurns(
    dmChannelId: string,
    options: BotMemoryReadOptions,
  ): Promise<BotMemoryTurn[]> {
    if (options.limit <= 0) return [];
    if (!dmChannelId.startsWith('D')) return [];

    const cutoff = Date.now() - options.sinceMs;

    const fresh = (this.turns.get(dmChannelId) ?? []).filter((turn) => turn.at.getTime() >= cutoff);

    const newestFirst = [...fresh].sort((a, b) => b.at.getTime() - a.at.getTime());

    return newestFirst.slice(0, options.limit).reverse();
  }
}

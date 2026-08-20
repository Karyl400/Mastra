export type BotMemoryRole = 'user' | 'assistant';

export interface BotMemoryTurn {
  readonly role: BotMemoryRole;
  readonly text: string;
  readonly slackUserId: string | null;
  readonly at: Date;
}

export interface BotMemoryReadOptions {
  readonly sinceMs: number;
  readonly limit: number;
}

export interface BotMemoryReadPort {
  recentDirectTurns(dmChannelId: string, options: BotMemoryReadOptions): Promise<BotMemoryTurn[]>;
}

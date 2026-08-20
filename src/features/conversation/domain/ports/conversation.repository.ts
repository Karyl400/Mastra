import type { ConversationTurn, NewConversationTurn } from '../entities/conversation-turn';

export const CONVERSATION_TTL_MS = 60 * 60 * 1000;

export interface RecentTurnsOptions {
  readonly ttlMs: number;
  readonly limit: number;
}

export interface ForgetScope {
  readonly conversationId: string;
  readonly slackUserId?: string | null;
}

export interface ConversationRepository {
  append(turn: NewConversationTurn): Promise<ConversationTurn>;

  recentTurns(conversationId: string, options: RecentTurnsOptions): Promise<ConversationTurn[]>;

  prune(olderThan: Date): Promise<number>;

  forget(scope: ForgetScope): Promise<number>;
}

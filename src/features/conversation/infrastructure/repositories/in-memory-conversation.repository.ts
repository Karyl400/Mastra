import type {
  ConversationTurn,
  NewConversationTurn,
} from '../../domain/entities/conversation-turn';
import type {
  ConversationRepository,
  ConversationForgetScope,
  RecentTurnsOptions,
} from '../../domain/ports/conversation.repository';

export class InMemoryConversationRepository implements ConversationRepository {
  private turns: ConversationTurn[] = [];

  async append(turn: NewConversationTurn): Promise<ConversationTurn> {
    const saved: ConversationTurn = {
      ...turn,
      id: crypto.randomUUID(),
      createdAt: new Date(),
    };
    this.turns.push(saved);
    return saved;
  }

  async findRecentTurns(
    conversationId: string,
    options: RecentTurnsOptions,
  ): Promise<ConversationTurn[]> {
    const cutoff = Date.now() - options.ttlMs;
    const alive = this.turns.filter(
      (turn) => turn.conversationId === conversationId && turn.createdAt.getTime() >= cutoff,
    );
    return options.limit > 0 ? alive.slice(-options.limit) : [];
  }

  async pruneOlderThan(cutoff: Date): Promise<number> {
    const before = this.turns.length;
    this.turns = this.turns.filter((turn) => turn.createdAt.getTime() >= cutoff.getTime());
    return before - this.turns.length;
  }

  async forget(scope: ConversationForgetScope): Promise<number> {
    const before = this.turns.length;

    this.turns = this.turns.filter((turn) => {
      if (turn.conversationId !== scope.conversationId) return true;
      return scope.slackUserId ? turn.slackUserId !== scope.slackUserId : false;
    });

    return before - this.turns.length;
  }

  clear(): void {
    this.turns = [];
  }
}

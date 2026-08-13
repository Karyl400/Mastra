import type {
  ConversationTurn,
  NewConversationTurn,
} from '../../domain/entities/conversation-turn';
import type {
  ConversationRepository,
  ForgetScope,
  RecentTurnsOptions,
} from '../../domain/ports/conversation.repository';

/**
 * Doublure de test du `ConversationRepository`. Même contrat, même sémantique de TTL et de
 * `limit` que l'implémentation Drizzle — c'est elle qui sert de doublure dans les tests
 * unitaires, on ne mocke jamais Drizzle à la main.
 *
 * Les tours sont conservés dans leur ordre d'insertion, qui EST l'ordre chronologique : aucun
 * tri n'est nécessaire, ce qui évite l'instabilité sur deux tours horodatés à la même
 * milliseconde.
 */
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

  async recentTurns(
    conversationId: string,
    options: RecentTurnsOptions,
  ): Promise<ConversationTurn[]> {
    const cutoff = Date.now() - options.ttlMs;
    const alive = this.turns.filter(
      (turn) => turn.conversationId === conversationId && turn.createdAt.getTime() >= cutoff,
    );
    // `slice(-limit)` : on garde les PLUS RÉCENTS, tout en rendant l'ordre chronologique.
    return options.limit > 0 ? alive.slice(-options.limit) : [];
  }

  async prune(olderThan: Date): Promise<number> {
    const before = this.turns.length;
    this.turns = this.turns.filter((turn) => turn.createdAt.getTime() >= olderThan.getTime());
    return before - this.turns.length;
  }

  /** Même sémantique que l'implémentation Drizzle : aucune borne de temps, un compte rendu. */
  async forget(scope: ForgetScope): Promise<number> {
    const before = this.turns.length;

    this.turns = this.turns.filter((turn) => {
      if (turn.conversationId !== scope.conversationId) return true;
      // Filtrer par personne épargne les tours `assistant` (`slackUserId: null`) : voir le
      // commentaire du port, c'est voulu.
      return scope.slackUserId ? turn.slackUserId !== scope.slackUserId : false;
    });

    return before - this.turns.length;
  }

  /** Confort de test : vide le dépôt entre deux cas. */
  clear(): void {
    this.turns = [];
  }
}

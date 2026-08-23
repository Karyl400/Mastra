import { and, desc, eq, gte, lt } from 'drizzle-orm';
import { getDb } from '../../../../infrastructure/database/connection';
import { conversationTurns } from '../../../../infrastructure/database/schema';
import type { ConversationTurnRow } from '../../../../infrastructure/database/schema';
import type {
  ConversationRole,
  ConversationTurn,
  NewConversationTurn,
} from '../../domain/entities/conversation-turn';
import type {
  ConversationRepository,
  ConversationForgetScope,
  RecentTurnsOptions,
} from '../../domain/ports/conversation.repository';

export class DrizzleConversationRepository implements ConversationRepository {
  async append(turn: NewConversationTurn): Promise<ConversationTurn> {
    const db = getDb();
    const saved: ConversationTurn = {
      ...turn,
      id: crypto.randomUUID(),
      createdAt: new Date(),
    };

    await db.insert(conversationTurns).values(saved);

    return saved;
  }

  async findRecentTurns(
    conversationId: string,
    options: RecentTurnsOptions,
  ): Promise<ConversationTurn[]> {
    if (options.limit <= 0) return [];

    const db = getDb();
    const cutoff = new Date(Date.now() - options.ttlMs);

    const rows = await db
      .select()
      .from(conversationTurns)
      .where(
        and(
          eq(conversationTurns.conversationId, conversationId),
          gte(conversationTurns.createdAt, cutoff),
        ),
      )
      .orderBy(desc(conversationTurns.createdAt))
      .limit(options.limit);

    return rows.reverse().map(toDomain);
  }

  async pruneOlderThan(cutoff: Date): Promise<number> {
    const db = getDb();
    const result = await db
      .delete(conversationTurns)
      .where(lt(conversationTurns.createdAt, cutoff));
    return (result as { rowsAffected?: number }).rowsAffected ?? 0;
  }

  async forget(scope: ConversationForgetScope): Promise<number> {
    const db = getDb();

    const where = scope.slackUserId
      ? and(
          eq(conversationTurns.conversationId, scope.conversationId),
          eq(conversationTurns.slackUserId, scope.slackUserId),
        )
      : eq(conversationTurns.conversationId, scope.conversationId);

    const result = await db.delete(conversationTurns).where(where);
    return (result as { rowsAffected?: number }).rowsAffected ?? 0;
  }
}

function toDomain(row: ConversationTurnRow): ConversationTurn {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role as ConversationRole,
    content: row.content,
    agentId: row.agentId,
    slackUserId: row.slackUserId ?? null,
    createdAt: row.createdAt,
  };
}

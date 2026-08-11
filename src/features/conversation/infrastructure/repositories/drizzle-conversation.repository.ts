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
  RecentTurnsOptions,
} from '../../domain/ports/conversation.repository';

/**
 * Persistance des tours de conversation sur LibSQL/Turso.
 *
 * ⚠️ La table `conversation_turns` n'est PAS créée par les migrations `drizzle/` : celles-ci
 * sont désynchronisées de `schema.ts`, et `drizzle-kit push` se bloque indéfiniment contre une
 * base `libsql://` distante. Le DDL à appliquer à la main vit dans
 * `scripts/ddl-conversation-turns.sql`.
 */
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

  async recentTurns(
    conversationId: string,
    options: RecentTurnsOptions,
  ): Promise<ConversationTurn[]> {
    if (options.limit <= 0) return [];

    const db = getDb();
    const cutoff = new Date(Date.now() - options.ttlMs);

    // Tri DESC + `limit` pour tirer les tours les plus RÉCENTS — un `limit` sur un tri ASC
    // ramènerait le début du fil, c'est-à-dire exactement ce qu'on veut oublier.
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

    // Remis à l'endroit : le port promet du plus ancien au plus récent.
    return rows.reverse().map(toDomain);
  }

  async prune(olderThan: Date): Promise<number> {
    const db = getDb();
    const result = await db
      .delete(conversationTurns)
      .where(lt(conversationTurns.createdAt, olderThan));
    return (result as { rowsAffected?: number }).rowsAffected ?? 0;
  }
}

function toDomain(row: ConversationTurnRow): ConversationTurn {
  return {
    id: row.id,
    conversationId: row.conversationId,
    // SQLite ne connaît pas les unions littérales : la colonne est un `text` libre, la
    // contrainte vit dans le domaine.
    role: row.role as ConversationRole,
    content: row.content,
    agentId: row.agentId,
    slackUserId: row.slackUserId ?? null,
    createdAt: row.createdAt,
  };
}

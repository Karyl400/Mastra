import { and, desc, eq, gte } from 'drizzle-orm';

import { getDb } from '../../../../infrastructure/database/connection';
import { conversationTurns } from '../../../../infrastructure/database/schema';
import type { ConversationTurnRow } from '../../../../infrastructure/database/schema';
import type {
  BotMemoryReadOptions,
  BotMemoryReadPort,
  BotMemoryRole,
  BotMemoryTurn,
} from '../../domain/ports/bot-memory.repository';

export class DrizzleBotMemoryRepository implements BotMemoryReadPort {
  async findRecentDirectTurns(
    dmChannelId: string,
    options: BotMemoryReadOptions,
  ): Promise<BotMemoryTurn[]> {
    if (options.limit <= 0) return [];

    if (!dmChannelId.startsWith('D')) return [];

    const db = getDb();
    const cutoff = new Date(Date.now() - options.sinceMs);

    const rows = await db
      .select()
      .from(conversationTurns)
      .where(
        and(
          eq(conversationTurns.conversationId, dmChannelId),
          gte(conversationTurns.createdAt, cutoff),
        ),
      )
      .orderBy(desc(conversationTurns.createdAt))
      .limit(options.limit);

    return rows.reverse().map(toDomain);
  }
}

function toDomain(row: ConversationTurnRow): BotMemoryTurn {
  return {
    role: row.role as BotMemoryRole,
    text: row.content,
    slackUserId: row.slackUserId ?? null,
    at: row.createdAt,
  };
}

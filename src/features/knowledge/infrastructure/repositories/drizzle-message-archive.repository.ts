import { and, asc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';

import { getDb } from '../../../../infrastructure/database/connection';
import { channelMessages } from '../../../../infrastructure/database/schema';
import type {
  ArchivedMessage,
  MessageArchiveRepository,
  MessageSearchOptions,
} from '../../domain/ports/message-archive.repository';
import { toMatchQuery } from '../../domain/services/fts-query';
import type { ForgetScope } from '../../domain/ports/message-archive.repository';

const DEFAULT_LIMIT = 20;

const MAX_LIMIT = 50;

interface Row {
  id: string;
  channel_id: string;
  slack_user_id: string | null;
  text: string;
  thread_ts: string | null;
  posted_at: number;
}

function toDomain(row: Row): ArchivedMessage {
  return {
    id: row.id,
    channelId: row.channel_id,
    slackUserId: row.slack_user_id,
    text: row.text,
    threadTs: row.thread_ts,
    postedAt: Number(row.posted_at),
  };
}

export class DrizzleMessageArchiveRepository implements MessageArchiveRepository {
  async archive(message: ArchivedMessage): Promise<boolean> {
    const db = getDb();

    const result = await db
      .insert(channelMessages)
      .values({
        id: message.id,
        channelId: message.channelId,
        slackUserId: message.slackUserId,
        text: message.text,
        threadTs: message.threadTs,
        postedAt: message.postedAt,
        createdAt: Date.now(),
      })
      .onConflictDoNothing()
      .run();

    return result.rowsAffected > 0;
  }

  async search(query: string, options: MessageSearchOptions = {}): Promise<ArchivedMessage[]> {
    const match = toMatchQuery(query);
    if (!match) return [];

    const limit = Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const db = getDb();

    const rows = await db.all<Row>(sql`
      SELECT m.id, m.channel_id, m.slack_user_id, m.text, m.thread_ts, m.posted_at
      FROM channel_messages_fts f
      JOIN channel_messages m ON m.rowid = f.rowid
      WHERE channel_messages_fts MATCH ${match}
        AND (${options.channelId ?? null} IS NULL OR m.channel_id = ${options.channelId ?? null})
        AND (${options.slackUserId ?? null} IS NULL OR m.slack_user_id = ${options.slackUserId ?? null})
      ORDER BY bm25(channel_messages_fts), m.posted_at DESC
      LIMIT ${limit}
    `);

    return rows.map(toDomain);
  }

  async forgetUser(scope: ForgetScope): Promise<number> {
    const db = getDb();
    const where =
      scope.channelId === undefined
        ? eq(channelMessages.slackUserId, scope.slackUserId)
        : and(
            eq(channelMessages.slackUserId, scope.slackUserId),
            eq(channelMessages.channelId, scope.channelId),
          );
    const result = await db.delete(channelMessages).where(where).run();

    return result.rowsAffected;
  }

  async pruneOlderThan(cutoffMs: number): Promise<number> {
    const db = getDb();
    const result = await db
      .delete(channelMessages)
      .where(lt(channelMessages.postedAt, cutoffMs))
      .run();

    return result.rowsAffected;
  }

  async pendingDistillation(sinceMs: number, limit: number): Promise<readonly ArchivedMessage[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(channelMessages)
      .where(
        and(
          isNull(channelMessages.distilledAt),
          gte(channelMessages.postedAt, Date.now() - sinceMs),
        ),
      )
      .orderBy(asc(channelMessages.postedAt))
      .limit(limit);

    return (rows as unknown as Row[]).map(toDomain);
  }

  async markDistilled(ids: readonly string[], at: number): Promise<number> {
    if (ids.length === 0) return 0;

    const db = getDb();
    const result = await db
      .update(channelMessages)
      .set({ distilledAt: at })
      .where(inArray(channelMessages.id, [...ids]))
      .run();

    return result.rowsAffected;
  }
}

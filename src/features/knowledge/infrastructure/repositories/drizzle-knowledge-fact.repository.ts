import { and, eq, lt, sql } from 'drizzle-orm';

import { getDb } from '../../../../infrastructure/database/connection';
import { knowledgeFacts } from '../../../../infrastructure/database/schema';
import type {
  KnowledgeFact,
  KnowledgeFactRepository,
  KnowledgeFactSearchOptions,
} from '../../domain/ports/knowledge-fact.repository';
import type { FactKind } from '../../domain/services/fact-distillation';
import { toMatchQuery } from '../../domain/services/fts-query';
import type { ForgetScope } from '../../domain/ports/message-archive.repository';

const DEFAULT_LIMIT = 12;

const MAX_LIMIT = 30;

interface Row {
  id: string;
  channel_id: string;
  slack_user_id: string | null;
  kind: string;
  summary: string;
  score: number;
  posted_at: number;
}

function toDomain(row: Row): KnowledgeFact {
  return {
    id: row.id,
    channelId: row.channel_id,
    slackUserId: row.slack_user_id,
    kind: row.kind as FactKind,
    summary: row.summary,
    score: Number(row.score),
    postedAt: Number(row.posted_at),
  };
}

export class DrizzleKnowledgeFactRepository implements KnowledgeFactRepository {
  async record(fact: KnowledgeFact): Promise<boolean> {
    const db = getDb();

    const result = await db
      .insert(knowledgeFacts)
      .values({
        id: fact.id,
        channelId: fact.channelId,
        slackUserId: fact.slackUserId,
        kind: fact.kind,
        summary: fact.summary,
        score: fact.score,
        postedAt: fact.postedAt,
        createdAt: Date.now(),
      })
      .onConflictDoNothing()
      .run();

    return result.rowsAffected > 0;
  }

  async search(query: string, options: KnowledgeFactSearchOptions = {}): Promise<KnowledgeFact[]> {
    const match = toMatchQuery(query);
    if (!match) return [];

    const limit = Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const db = getDb();

    const rows = await db.all<Row>(sql`
      SELECT k.id, k.channel_id, k.slack_user_id, k.kind, k.summary, k.score, k.posted_at
      FROM knowledge_facts_fts f
      JOIN knowledge_facts k ON k.rowid = f.rowid
      WHERE knowledge_facts_fts MATCH ${match}
        AND (${options.channelId ?? null} IS NULL OR k.channel_id = ${options.channelId ?? null})
        AND (${options.slackUserId ?? null} IS NULL OR k.slack_user_id = ${options.slackUserId ?? null})
      ORDER BY bm25(knowledge_facts_fts), k.score DESC, k.posted_at DESC
      LIMIT ${limit}
    `);

    return rows.map(toDomain);
  }

  async recent(options: KnowledgeFactSearchOptions = {}): Promise<KnowledgeFact[]> {
    const limit = Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const db = getDb();

    const rows = await db.all<Row>(sql`
      SELECT k.id, k.channel_id, k.slack_user_id, k.kind, k.summary, k.score, k.posted_at
      FROM knowledge_facts k
      WHERE (${options.channelId ?? null} IS NULL OR k.channel_id = ${options.channelId ?? null})
        AND (${options.slackUserId ?? null} IS NULL OR k.slack_user_id = ${options.slackUserId ?? null})
      ORDER BY k.posted_at DESC
      LIMIT ${limit}
    `);

    return rows.map(toDomain);
  }

  async forgetUser(scope: ForgetScope): Promise<number> {
    const db = getDb();
    const where =
      scope.channelId === undefined
        ? eq(knowledgeFacts.slackUserId, scope.slackUserId)
        : and(
            eq(knowledgeFacts.slackUserId, scope.slackUserId),
            eq(knowledgeFacts.channelId, scope.channelId),
          );
    const result = await db.delete(knowledgeFacts).where(where).run();

    return result.rowsAffected;
  }

  async pruneOlderThan(cutoffMs: number): Promise<number> {
    const db = getDb();
    const result = await db
      .delete(knowledgeFacts)
      .where(lt(knowledgeFacts.postedAt, cutoffMs))
      .run();

    return result.rowsAffected;
  }
}

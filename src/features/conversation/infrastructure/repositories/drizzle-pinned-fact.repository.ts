import { asc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../../../infrastructure/database/connection';
import { pinnedFacts } from '../../../../infrastructure/database/schema';
import type { PinnedFact, PinnedFactRepository } from '../../domain/ports/pinned-fact.repository';

export class DrizzlePinnedFactRepository implements PinnedFactRepository {
  async list(slackUserId: string, limit: number): Promise<PinnedFact[]> {
    if (limit <= 0) return [];

    const db = getDb();
    const rows = await db
      .select()
      .from(pinnedFacts)
      .where(eq(pinnedFacts.slackUserId, slackUserId))
      .orderBy(asc(pinnedFacts.createdAt))
      .limit(limit);

    return rows.map(toDomain);
  }

  async pin(fact: PinnedFact, max: number): Promise<void> {
    const db = getDb();

    if (max > 0) {
      const existing = await db
        .select({ id: pinnedFacts.id })
        .from(pinnedFacts)
        .where(eq(pinnedFacts.slackUserId, fact.slackUserId))
        .orderBy(asc(pinnedFacts.createdAt));

      const surplus = existing.slice(0, Math.max(0, existing.length - (max - 1)));
      if (surplus.length > 0) {
        await db.delete(pinnedFacts).where(
          inArray(
            pinnedFacts.id,
            surplus.map((row) => row.id),
          ),
        );
      }
    }

    await db.insert(pinnedFacts).values(fact);
  }

  async forget(slackUserId: string): Promise<number> {
    const db = getDb();
    const result = await db.delete(pinnedFacts).where(eq(pinnedFacts.slackUserId, slackUserId));

    return (result as { rowsAffected?: number }).rowsAffected ?? 0;
  }
}

function toDomain(row: typeof pinnedFacts.$inferSelect): PinnedFact {
  return {
    id: row.id,
    slackUserId: row.slackUserId,
    fact: row.fact,
    createdAt: row.createdAt,
  };
}

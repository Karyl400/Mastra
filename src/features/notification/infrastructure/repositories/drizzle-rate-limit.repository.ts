import { lte, sql } from 'drizzle-orm';
import { getDb, type DatabaseInstance } from '../../../../infrastructure/database/connection';
import { rateLimitCounters } from '../../../../infrastructure/database/schema';
import type { RateLimitRepository } from '../../domain/ports/rate-limit.repository';

export class DrizzleRateLimitRepository implements RateLimitRepository {
  constructor(private readonly resolveDb: () => DatabaseInstance = getDb) {}

  async increment(key: string, windowStart: Date, expiresAt: Date, by = 1): Promise<number> {
    const db = this.resolveDb();

    const step = Number.isFinite(by) && by > 0 ? Math.round(by) : 0;

    const [row] = await db
      .insert(rateLimitCounters)
      .values({ key, count: step, windowStart, expiresAt })
      .onConflictDoUpdate({
        target: rateLimitCounters.key,
        set: { count: sql`${rateLimitCounters.count} + ${step}` },
      })
      .returning({ count: rateLimitCounters.count });

    return row?.count ?? 0;
  }

  async prune(now: Date): Promise<number> {
    const db = this.resolveDb();
    const result = await db.delete(rateLimitCounters).where(lte(rateLimitCounters.expiresAt, now));
    return rowsAffected(result);
  }
}

function rowsAffected(result: unknown): number {
  return (result as { rowsAffected?: number }).rowsAffected ?? 0;
}

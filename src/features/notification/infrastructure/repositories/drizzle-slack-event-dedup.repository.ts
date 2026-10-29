import { and, eq, lt, lte } from 'drizzle-orm';
import { getDb } from '../../../../infrastructure/database/connection';
import { slackEventDedup } from '../../../../infrastructure/database/schema';
import type {
  SlackEventClaim,
  SlackEventClaimOptions,
  SlackEventDedupRepository,
  SlackEventDedupStatus,
} from '../../domain/ports/slack-event-dedup.repository';
import { affectedRowsOrThrow } from '../../../../shared/rows-affected';

export class DrizzleSlackEventDedupRepository implements SlackEventDedupRepository {
  async claim(key: string, options: SlackEventClaimOptions): Promise<SlackEventClaim> {
    const db = getDb();
    const now = Date.now();

    const inserted = await db
      .insert(slackEventDedup)
      .values({ key, status: 'in-flight', startedAt: new Date(now) })
      .onConflictDoNothing();

    if (affectedRowsOrThrow(inserted, 'la prise de déduplication Slack') > 0) {
      return { granted: true, reclaimed: false };
    }

    const cutoff = new Date(now - options.inFlightGraceMs);
    const reclaimed = await db
      .update(slackEventDedup)
      .set({ status: 'in-flight', startedAt: new Date(now) })
      .where(
        and(
          eq(slackEventDedup.key, key),
          eq(slackEventDedup.status, 'in-flight'),
          lte(slackEventDedup.startedAt, cutoff),
        ),
      );

    if (affectedRowsOrThrow(reclaimed, 'la reprise d’un événement Slack abandonné') > 0) {
      return { granted: true, reclaimed: true };
    }

    const [row] = await db
      .select()
      .from(slackEventDedup)
      .where(eq(slackEventDedup.key, key))
      .limit(1);

    if (!row) {
      return { granted: false, status: 'unknown', ageMs: null };
    }

    return {
      granted: false,
      status: row.status as SlackEventDedupStatus,
      ageMs: now - row.startedAt.getTime(),
    };
  }

  async markDone(key: string): Promise<void> {
    const db = getDb();
    await db
      .insert(slackEventDedup)
      .values({ key, status: 'done', startedAt: new Date() })
      .onConflictDoUpdate({
        target: slackEventDedup.key,
        set: { status: 'done', startedAt: new Date() },
      });
  }

  async release(key: string): Promise<void> {
    const db = getDb();
    await db.delete(slackEventDedup).where(eq(slackEventDedup.key, key));
  }

  async pruneOlderThan(cutoff: Date): Promise<number> {
    const db = getDb();
    const result = await db.delete(slackEventDedup).where(lt(slackEventDedup.startedAt, cutoff));
    return affectedRowsOrThrow(result, 'la purge des clés de déduplication');
  }
}

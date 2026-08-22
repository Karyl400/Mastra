import type {
  SlackEventClaim,
  SlackEventClaimOptions,
  SlackEventDedupRepository,
  SlackEventDedupStatus,
} from '../../domain/ports/slack-event-dedup.repository';

interface DedupRow {
  status: SlackEventDedupStatus;
  startedAt: number;
}

export class InMemorySlackEventDedupRepository implements SlackEventDedupRepository {
  private rows = new Map<string, DedupRow>();

  async claim(key: string, options: SlackEventClaimOptions): Promise<SlackEventClaim> {
    const now = Date.now();
    const existing = this.rows.get(key);

    if (!existing) {
      this.rows.set(key, { status: 'in-flight', startedAt: now });
      return { granted: true, reclaimed: false };
    }

    const ageMs = now - existing.startedAt;
    const abandoned = existing.status === 'in-flight' && ageMs >= options.inFlightGraceMs;

    if (!abandoned) {
      return { granted: false, status: existing.status, ageMs };
    }

    this.rows.set(key, { status: 'in-flight', startedAt: now });
    return { granted: true, reclaimed: true };
  }

  async markDone(key: string): Promise<void> {
    this.rows.set(key, { status: 'done', startedAt: Date.now() });
  }

  async release(key: string): Promise<void> {
    this.rows.delete(key);
  }

  async pruneOlderThan(cutoff: Date): Promise<number> {
    const cutoffMs = cutoff.getTime();
    let removed = 0;
    for (const [key, row] of this.rows) {
      if (row.startedAt < cutoffMs) {
        this.rows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.rows.clear();
  }
}

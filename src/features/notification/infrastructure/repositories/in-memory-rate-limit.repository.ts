import type { RateLimitRepository } from '../../domain/ports/rate-limit.repository';

interface CounterRow {
  count: number;
  expiresAt: number;
}

export class InMemoryRateLimitRepository implements RateLimitRepository {
  private rows = new Map<string, CounterRow>();

  async increment(key: string, _windowStart: Date, expiresAt: Date, by = 1): Promise<number> {
    const step = Number.isFinite(by) && by > 0 ? Math.round(by) : 0;
    const existing = this.rows.get(key);

    if (!existing) {
      this.rows.set(key, { count: step, expiresAt: expiresAt.getTime() });
      return step;
    }

    existing.count += step;
    return existing.count;
  }

  async pruneExpired(now: Date): Promise<number> {
    const cutoff = now.getTime();
    let removed = 0;

    for (const [key, row] of this.rows) {
      if (row.expiresAt <= cutoff) {
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

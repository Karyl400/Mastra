import type { PinnedFact, PinnedFactRepository } from '../../domain/ports/pinned-fact.repository';

export class InMemoryPinnedFactRepository implements PinnedFactRepository {
  private rows: PinnedFact[] = [];

  async list(slackUserId: string, limit: number): Promise<PinnedFact[]> {
    if (limit <= 0) return [];

    return this.rows
      .filter((row) => row.slackUserId === slackUserId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit);
  }

  async pin(fact: PinnedFact, max: number): Promise<void> {
    if (max > 0) {
      const mine = this.rows
        .filter((row) => row.slackUserId === fact.slackUserId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

      const surplus = new Set(mine.slice(0, Math.max(0, mine.length - (max - 1))).map((r) => r.id));
      this.rows = this.rows.filter((row) => !surplus.has(row.id));
    }

    this.rows.push(fact);
  }

  async forget(slackUserId: string): Promise<number> {
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => row.slackUserId !== slackUserId);
    return before - this.rows.length;
  }
}

import type { PinnedFact, PinnedFactRepository } from '../../domain/ports/pinned-fact.repository';

/**
 * Doublure de `DrizzlePinnedFactRepository`.
 *
 * ⚠️ Elle doit reproduire EXACTEMENT l'éviction : faire de la place AVANT d'insérer, sur
 * `max - 1`. Une doublure plus permissive validerait en test un plafond que la production
 * n'applique pas — et ce plafond est ce qui empêche le préambule système de grossir sans
 * borne, à chaque aller-retour, sur un budget de ≈ 19 messages par jour.
 */
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

import type {
  SlackEventClaim,
  SlackEventClaimOptions,
  SlackEventDedupRepository,
  SlackEventDedupStatus,
} from '../../domain/ports/slack-event-dedup.repository';

interface DedupRow {
  status: SlackEventDedupStatus;
  /** `Date.now()` au moment où le statut courant a été posé. */
  startedAt: number;
}

/**
 * Doublure de test du `SlackEventDedupRepository`. Même contrat et même sémantique que
 * l'implémentation Drizzle — c'est elle qui sert de doublure dans les tests unitaires, on ne
 * mocke jamais Drizzle à la main.
 *
 * Une SEULE instance partagée entre deux handlers simule deux instances serverless devant le
 * même store : c'est ainsi que se teste la déduplication multi-instance.
 *
 * ⚠️ `claim()` ne comporte AUCUN `await` avant sa mutation, et c'est délibéré : en JavaScript,
 * un corps de fonction sans point de suspension est atomique. La doublure reproduit donc la
 * garantie que l'implémentation Drizzle obtient de `INSERT … ON CONFLICT DO NOTHING`. Y
 * insérer un `await` entre la lecture et l'écriture réintroduirait exactement la fenêtre de
 * concurrence que ce port ferme.
 */
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
    // La grâce ne s'applique QU'À `in-flight` : une entrée `done` est un refus définitif.
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

  async prune(olderThan: Date): Promise<number> {
    const cutoff = olderThan.getTime();
    let removed = 0;
    for (const [key, row] of this.rows) {
      if (row.startedAt < cutoff) {
        this.rows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Confort de test : vide le dépôt entre deux cas. */
  clear(): void {
    this.rows.clear();
  }
}

import { and, eq, lt, lte } from 'drizzle-orm';
import { getDb } from '../../../../infrastructure/database/connection';
import { slackEventDedup } from '../../../../infrastructure/database/schema';
import type {
  SlackEventClaim,
  SlackEventClaimOptions,
  SlackEventDedupRepository,
  SlackEventDedupStatus,
} from '../../domain/ports/slack-event-dedup.repository';

/**
 * Déduplication partagée des événements Slack, sur LibSQL/Turso.
 *
 * ⚠️ La table `slack_event_dedup` n'est PAS créée par les migrations `drizzle/` : celles-ci
 * sont désynchronisées de `schema.ts`, et `drizzle-kit push` se bloque indéfiniment contre une
 * base `libsql://` distante. Le DDL à appliquer à la main vit dans
 * `scripts/ddl-slack-event-dedup.sql`.
 *
 * COÛT : `claim()` fait UN aller-retour dans le cas passant (l'événement est neuf), et c'est
 * un plafond assumé — il tourne avant l'ACK HTTP, celui qui a 3 secondes. Les allers-retours
 * supplémentaires ne concernent que le chemin REFUSÉ (un rejeu, donc rare) et ne servent qu'à
 * journaliser pourquoi.
 */
export class DrizzleSlackEventDedupRepository implements SlackEventDedupRepository {
  async claim(key: string, options: SlackEventClaimOptions): Promise<SlackEventClaim> {
    const db = getDb();
    const now = Date.now();

    // 1. PRISE ATOMIQUE. Tout repose sur cette ligne : la PRIMARY KEY arbitre la course, et
    //    le nombre de lignes affectées dit qui a gagné. Un `SELECT` préalable — la forme
    //    « naturelle » — rouvrirait la fenêtre de concurrence que ce dépôt existe pour
    //    fermer : deux instances liraient « absente » avant que l'une écrive.
    const inserted = await db
      .insert(slackEventDedup)
      .values({ key, status: 'in-flight', startedAt: new Date(now) })
      .onConflictDoNothing();

    if (rowsAffected(inserted) > 0) return { granted: true, reclaimed: false };

    // 2. REPRISE D'UNE ENTRÉE ABANDONNÉE — atomique elle aussi. Le `WHERE` porte l'entièreté
    //    de la condition (`in-flight` ET plus vieille que la grâce) : deux instances en course
    //    sur la même entrée périmée ne peuvent pas la reprendre toutes les deux, la seconde
    //    voit `started_at` déjà rafraîchi et n'affecte aucune ligne.
    //
    //    `lte` et non `lt` : avec une grâce nulle, `cutoff === now` et une entrée posée dans
    //    la même milliseconde doit être reprenable — c'est la sémantique `ageMs >= grace`
    //    du cache mémoire, qu'on conserve à l'identique.
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

    if (rowsAffected(reclaimed) > 0) return { granted: true, reclaimed: true };

    // 3. REFUS. La relecture ne sert QUE le log : elle n'entre dans aucune décision de prise,
    //    et n'a donc aucun effet sur la concurrence.
    const [row] = await db
      .select()
      .from(slackEventDedup)
      .where(eq(slackEventDedup.key, key))
      .limit(1);

    if (!row) {
      // La ligne a disparu entre la prise et la relecture (purge concurrente). On refuse
      // quand même : mieux vaut une réponse manquée qu'une réponse en double, et la fenêtre
      // de rejeu de Slack est bien plus courte que la rétention.
      return { granted: false, status: 'unknown', ageMs: null };
    }

    return {
      granted: false,
      // SQLite ne connaît pas les unions littérales : la colonne est un `text` libre, la
      // contrainte vit dans le domaine.
      status: row.status as SlackEventDedupStatus,
      ageMs: now - row.startedAt.getTime(),
    };
  }

  /**
   * Un `UPDATE` ne suffirait pas : la ligne peut avoir été purgée pendant un traitement long.
   * L'upsert garantit qu'un `done` posé reste un `done`, purge ou non.
   */
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

  async prune(olderThan: Date): Promise<number> {
    const db = getDb();
    const result = await db.delete(slackEventDedup).where(lt(slackEventDedup.startedAt, olderThan));
    return rowsAffected(result);
  }
}

/** Le pilote libSQL rend `rowsAffected` ; on ne suppose jamais sa présence. */
function rowsAffected(result: unknown): number {
  return (result as { rowsAffected?: number }).rowsAffected ?? 0;
}

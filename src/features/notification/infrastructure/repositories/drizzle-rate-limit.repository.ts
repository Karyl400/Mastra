import { lte, sql } from 'drizzle-orm';
import { getDb, type DatabaseInstance } from '../../../../infrastructure/database/connection';
import { rateLimitCounters } from '../../../../infrastructure/database/schema';
import type { RateLimitRepository } from '../../domain/ports/rate-limit.repository';

/**
 * Compteurs de limitation de débit PARTAGÉS entre instances, sur LibSQL/Turso.
 *
 * ⚠️ Comme `slack_event_dedup`, la table `rate_limit_counters` n'est PAS créée par les
 * migrations `drizzle/` : celles-ci sont désynchronisées de `schema.ts`, et `drizzle-kit push`
 * se bloque indéfiniment contre une base `libsql://` distante. Le DDL doit être appliqué à la
 * main sur toute base — locale, neuve ou de production — sinon `increment()` lève
 * `no such table: rate_limit_counters` et l'appelant retombe sur sa dégradation (autoriser).
 *
 * COÛT : `increment()` fait UN aller-retour, toujours, quel que soit l'état de la ligne. C'est
 * un plafond assumé et non négociable — le contrôle tourne avant l'ACK Slack, celui qui n'a que
 * 3 secondes.
 */
export class DrizzleRateLimitRepository implements RateLimitRepository {
  /**
   * La connexion est résolue PARESSEUSEMENT (fonction, pas instance) : la construire ici
   * ouvrirait la base au chargement du module, donc au câblage de `src/mastra/index.ts`. Le
   * paramètre existe aussi pour les tests, qui injectent une base libsql en mémoire plutôt que
   * de mocker Drizzle à la main.
   */
  constructor(private readonly resolveDb: () => DatabaseInstance = getDb) {}

  /**
   * UN SEUL énoncé, atomique, qui rend la valeur d'après incrément :
   *
   *   INSERT INTO rate_limit_counters (key, count, window_start, expires_at)
   *   VALUES (?, 1, ?, ?)
   *   ON CONFLICT(key) DO UPDATE SET count = count + 1
   *   RETURNING count
   *
   * Un `SELECT` suivi d'un `UPDATE` — la forme « naturelle » — rouvrirait la fenêtre de
   * concurrence que ce dépôt existe pour fermer : deux instances liraient la même valeur avant
   * que l'une écrive, et la limite serait franchissable par simple parallélisme. C'est le même
   * raisonnement, et la même forme, que la prise atomique de `slack_event_dedup`.
   *
   * VÉRIFIÉ : Drizzle 0.45 + `@libsql/client` acceptent bien `.returning()` derrière un
   * `.onConflictDoUpdate()`, et rendent la valeur ISSUE DE L'UPDATE (1, puis 2, puis 3…). Il
   * n'y a donc aucune raison de descendre au client libsql brut (`db.run(sql\`…\`)`), ce qui
   * aurait coûté la vérification de types sur les noms de colonnes.
   *
   * `window_start` et `expires_at` ne sont volontairement PAS réécrits sur conflit : la clé
   * porte déjà le numéro de fenêtre (`buildCounterKey`), donc toutes les lignes qui entrent en
   * conflit décrivent EXACTEMENT la même fenêtre. Les réécrire ne changerait rien — sauf le
   * jour où une horloge décalée d'une milliseconde repousserait l'expiration à chaque
   * incrément, offrant à une clé très sollicitée une survie indéfinie.
   */
  async increment(key: string, windowStart: Date, expiresAt: Date): Promise<number> {
    const db = this.resolveDb();

    const [row] = await db
      .insert(rateLimitCounters)
      .values({ key, count: 1, windowStart, expiresAt })
      .onConflictDoUpdate({
        target: rateLimitCounters.key,
        set: { count: sql`${rateLimitCounters.count} + 1` },
      })
      .returning({ count: rateLimitCounters.count });

    // `RETURNING` sur un upsert rend toujours une ligne. S'il n'en rend aucune, on ne devine
    // pas : `0` est précisément la valeur que `evaluateCount` traite comme « compte non
    // exploitable » et qui vaut AUTORISATION. Refuser sans preuve positive couperait le service
    // sur une bizarrerie du pilote — même arbitrage que la déduplication partagée.
    return row?.count ?? 0;
  }

  /**
   * `lte` et non `lt` : `expires_at` est déjà une date de fin FRANCHIE (elle inclut la marge de
   * purge de `rate-limit-policy.ts`). Une ligne dont l'expiration tombe exactement sur `now`
   * n'a plus rien à protéger.
   */
  async prune(now: Date): Promise<number> {
    const db = this.resolveDb();
    const result = await db.delete(rateLimitCounters).where(lte(rateLimitCounters.expiresAt, now));
    return rowsAffected(result);
  }
}

/** Le pilote libSQL rend `rowsAffected` ; on ne suppose jamais sa présence. */
function rowsAffected(result: unknown): number {
  return (result as { rowsAffected?: number }).rowsAffected ?? 0;
}

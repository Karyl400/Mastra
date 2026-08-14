import { asc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../../../infrastructure/database/connection';
import { pinnedFacts } from '../../../../infrastructure/database/schema';
import type { PinnedFact, PinnedFactRepository } from '../../domain/ports/pinned-fact.repository';

/**
 * Persistance des faits épinglés sur LibSQL/Turso.
 *
 * ⚠️ La table `pinned_facts` n'est PAS créée par les migrations `drizzle/` : celles-ci sont
 * désynchronisées de `schema.ts`, et `drizzle-kit push` se bloque indéfiniment contre une base
 * `libsql://` distante. Le DDL à appliquer à la main vit dans `scripts/ddl-pinned-facts.sql`,
 * et il doit l'être AVANT le déploiement.
 */
export class DrizzlePinnedFactRepository implements PinnedFactRepository {
  async list(slackUserId: string, limit: number): Promise<PinnedFact[]> {
    if (limit <= 0) return [];

    const db = getDb();
    const rows = await db
      .select()
      .from(pinnedFacts)
      .where(eq(pinnedFacts.slackUserId, slackUserId))
      // Du plus ANCIEN au plus récent : c'est l'ordre dans lequel la personne les a donnés,
      // donc celui qui se lit. Le tri est explicite — sans `ORDER BY`, deux lectures
      // identiques peuvent rendre deux ordres différents (défaut déjà corrigé sur
      // `getNotificationHistory`).
      .orderBy(asc(pinnedFacts.createdAt))
      .limit(limit);

    return rows.map(toDomain);
  }

  /**
   * ⚠️ L'éviction se fait AVANT l'insertion, et sur `max - 1`.
   *
   * L'ordre importe : évincer après l'insertion supprimerait le fait qu'on vient d'ajouter
   * si l'horodatage se trouvait être le plus ancien (deux écritures dans la même
   * milliseconde, cas réel en serverless). On fait donc de la place, puis on écrit.
   *
   * Il n'y a PAS de transaction : LibSQL en supporte, mais le pire cas ici est de retomber
   * sous le plafond d'un fait pendant quelques millisecondes — sans conséquence, la borne
   * n'existant que pour le budget de tokens.
   */
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

    // `rowsAffected` est le champ rendu par le pilote libsql. Le contrat rend un NOMBRE et
    // non `void` pour la même raison que `OnboardingRepository.update` : sans lui, aucun
    // appelant ne peut distinguer une suppression réussie d'une suppression sur zéro ligne,
    // et la réponse rendue à la personne annoncerait un effacement qui n'a pas eu lieu.
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

import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb, type DatabaseInstance } from '../../../../infrastructure/database/connection';
import { slackDirectory, type SlackDirectoryRow } from '../../../../infrastructure/database/schema';
import type { DirectoryMember, DirectoryMemberFacts } from '../../domain/entities/directory-member';
import type { DirectoryRepository } from '../../domain/ports/directory.repository';
import { matchesName } from '../../../../shared/name-matching';

/**
 * Annuaire des personnes du workspace, sur LibSQL/Turso.
 *
 * ⚠️ La table `slack_directory` n'est PAS créée par les migrations `drizzle/` : celles-ci sont
 * désynchronisées de `schema.ts`, et `drizzle-kit push` se bloque indéfiniment contre une base
 * `libsql://` distante. Comme pour `conversation_turns` et `slack_event_dedup`, le DDL doit être
 * appliqué à la main sur toute base de production ou neuve.
 *
 * COÛT : `findBySlackUserId` fait UN aller-retour, sur la PRIMARY KEY. C'est un plafond imposé
 * par le port, pas une optimisation : elle tourne sur le chemin de l'ACK Slack, celui qui n'a
 * que 3 secondes et qui exécute déjà la prise de clé de déduplication.
 */
export class DrizzleDirectoryRepository implements DirectoryRepository {
  /**
   * La connexion est résolue PARESSEUSEMENT (fonction, pas instance) : la construire ici
   * ouvrirait la base au câblage de `src/mastra/index.ts`, au chargement du module. Le paramètre
   * existe pour les tests, qui injectent une base libsql en mémoire plutôt que de mocker
   * Drizzle à la main.
   */
  constructor(private readonly resolveDb: () => DatabaseInstance = getDb) {}

  async findBySlackUserId(slackUserId: string): Promise<DirectoryMember | null> {
    const db = this.resolveDb();
    const row = await db
      .select()
      .from(slackDirectory)
      .where(eq(slackDirectory.slackUserId, slackUserId))
      .get();

    return row ? toDomain(row) : null;
  }

  /**
   * Deux passes, et l'ordre est le fond :
   *
   *  1. égalité STRICTE — c'est la seule forme que `idx_slack_directory_email` sait servir. Un
   *     `lower(email) = ?` posé d'emblée désactiverait l'index sur toute la table ;
   *  2. repli insensible à la casse, seulement si la première n'a rien rendu. Slack livre des
   *     adresses en minuscules, donc ce chemin est celui du MISS — la comparaison faite par un
   *     humain qui tape « Awa.Diop@Kisso.com ». Faire payer un balayage au cas passant pour
   *     couvrir le cas rare serait l'arbitrage inverse.
   *
   * L'index reste NON unique (voir `schema.ts`) : deux comptes peuvent porter la même adresse le
   * temps d'une migration. On rend la première ligne, jamais une erreur — ce port répond à
   * « qui est-ce ? », il n'arbitre pas les doublons.
   */
  async findByEmail(email: string): Promise<DirectoryMember | null> {
    const db = this.resolveDb();
    const needle = email.trim();
    if (!needle) return null;

    const exact = await db
      .select()
      .from(slackDirectory)
      .where(eq(slackDirectory.email, needle))
      .get();

    if (exact) return toDomain(exact);

    const insensitive = await db
      .select()
      .from(slackDirectory)
      .where(sql`lower(${slackDirectory.email}) = ${needle.toLowerCase()}`)
      .get();

    return insensitive ? toDomain(insensitive) : null;
  }

  /**
   * ⚠️ LE POINT CRITIQUE DE CE FICHIER — le `set` de l'upsert énumère les champs UN À UN.
   *
   * Ce n'est pas de la verbosité : `set: { ...values }` ou `set: member` réécrirait
   * l'enregistrement ENTIER, donc `dm_channel_id`, `employee_id` et `first_seen_at` avec. Une
   * synchronisation complète repasse sur toutes les lignes ; à chaque passage elle effacerait
   * le canal de DM appris au fil des messages — un canal que Slack ne sait PAS nous rendre
   * (`conversations.list({types:'im'})` répond `missing_scope`), donc une perte définitive — et
   * le rattachement à l'employé. Muette, comme `documents.content` l'a été sur 6 lignes sur 6.
   *
   * `slack_user_id` est absent du `set` : c'est la cible du conflit, la réécrire n'a pas de sens.
   * `first_seen_at` n'est posé qu'à l'INSERT, c'est-à-dire une seule fois dans la vie de la ligne.
   */
  async upsertFacts(facts: DirectoryMemberFacts, now: Date): Promise<void> {
    const db = this.resolveDb();

    await db
      .insert(slackDirectory)
      .values({
        slackUserId: facts.slackUserId,
        teamId: facts.teamId,
        email: facts.email,
        realName: facts.realName,
        displayName: facts.displayName,
        firstName: facts.firstName,
        lastName: facts.lastName,
        title: facts.title,
        isBot: facts.isBot,
        isAdmin: facts.isAdmin,
        isRestricted: facts.isRestricted,
        isUltraRestricted: facts.isUltraRestricted,
        isDeleted: facts.isDeleted,
        firstSeenAt: now,
        syncedAt: now,
      })
      .onConflictDoUpdate({
        target: slackDirectory.slackUserId,
        set: {
          teamId: facts.teamId,
          email: facts.email,
          realName: facts.realName,
          displayName: facts.displayName,
          firstName: facts.firstName,
          lastName: facts.lastName,
          title: facts.title,
          isBot: facts.isBot,
          isAdmin: facts.isAdmin,
          isRestricted: facts.isRestricted,
          isUltraRestricted: facts.isUltraRestricted,
          isDeleted: facts.isDeleted,
          syncedAt: now,
        },
      });
  }

  /**
   * Le `IS NULL` de la clause `WHERE` porte TOUTE la garantie de non-destruction, et il la porte
   * atomiquement : deux DM traités en parallèle par deux instances ne peuvent pas se voler la
   * colonne, la seconde n'affecte aucune ligne. Un `SELECT` puis un `UPDATE` conditionnel — la
   * forme « naturelle » — rouvrirait cette course.
   *
   * Une personne absente de l'annuaire ne provoque rien : l'`UPDATE` n'affecte aucune ligne, on
   * ne lève pas. La ligne est créée par `upsertFacts`, jamais ici — fabriquer un enregistrement
   * à partir d'un seul identifiant de canal produirait un membre sans email, sans nom et sans
   * flag, c'est-à-dire un sujet d'autorisation dont tous les faits seraient des valeurs par
   * défaut.
   */
  async rememberDmChannel(slackUserId: string, dmChannelId: string): Promise<void> {
    const db = this.resolveDb();

    await db
      .update(slackDirectory)
      .set({ dmChannelId })
      .where(and(eq(slackDirectory.slackUserId, slackUserId), isNull(slackDirectory.dmChannelId)));
  }

  /** Destructif à dessein, contrairement à `rememberDmChannel` : `null` DÉTACHE, c'est le port. */
  async linkEmployee(slackUserId: string, employeeId: string | null): Promise<void> {
    const db = this.resolveDb();

    await db
      .update(slackDirectory)
      .set({ employeeId })
      .where(eq(slackDirectory.slackUserId, slackUserId));
  }

  /**
   * Résolution par nom : UN aller-retour, puis le rapprochement en mémoire.
   *
   * Voir `DrizzleEmployeeRepository.findByName` pour l'argumentaire complet — il vaut mot
   * pour mot ici : ni `lower()` ni `LIKE` ne savent faire ce rapprochement correctement,
   * et une correspondance en milieu de mot sur une résolution de personne est le défaut
   * qu'on corrige.
   *
   * La borne est ici l'effectif du WORKSPACE Slack (40 lignes en production au
   * 2026-08-14, bots et comptes désactivés compris), pas un volume de trafic.
   */
  async findByName(query: string, limit: number): Promise<DirectoryMember[]> {
    if (limit <= 0) return [];

    const db = this.resolveDb();
    const rows = await db.select().from(slackDirectory).orderBy(slackDirectory.slackUserId);

    const matches: DirectoryMember[] = [];
    for (const row of rows) {
      if (matches.length >= limit) break;
      if (matchesName(query, [row.firstName, row.lastName, row.displayName, row.realName])) {
        matches.push(toDomain(row));
      }
    }

    return matches;
  }

  /**
   * Tri explicite sur la clé : sans `ORDER BY`, deux appels identiques peuvent rendre deux ordres
   * différents — même défaut que celui corrigé sur `getNotificationHistory`.
   */
  async listAll(): Promise<DirectoryMember[]> {
    const db = this.resolveDb();
    const rows = await db.select().from(slackDirectory).orderBy(slackDirectory.slackUserId);
    return rows.map(toDomain);
  }
}

function toDomain(row: SlackDirectoryRow): DirectoryMember {
  return {
    slackUserId: row.slackUserId,
    teamId: row.teamId,
    email: row.email ?? null,
    realName: row.realName,
    displayName: row.displayName,
    firstName: row.firstName ?? null,
    lastName: row.lastName ?? null,
    title: row.title ?? null,
    isBot: row.isBot,
    isAdmin: row.isAdmin,
    isRestricted: row.isRestricted,
    isUltraRestricted: row.isUltraRestricted,
    isDeleted: row.isDeleted,
    dmChannelId: row.dmChannelId ?? null,
    employeeId: row.employeeId ?? null,
    firstSeenAt: row.firstSeenAt,
    syncedAt: row.syncedAt,
  };
}

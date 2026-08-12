import { and, asc, count, eq, lt } from 'drizzle-orm';
import { getDb, type DatabaseInstance } from '../../../../infrastructure/database/connection';
import {
  slackChannelMembers,
  slackChannels,
  type SlackChannelMemberRow,
  type SlackChannelRow,
} from '../../../../infrastructure/database/schema';
import type {
  SlackChannelFacts,
  SlackChannelInventoryEntry,
  SlackChannelMembership,
  SlackChannelRecord,
} from '../../domain/entities/slack-channel';
import type { ChannelInventoryRepository } from '../../domain/ports/channel.repository';

/**
 * Inventaire des canaux sur LibSQL/Turso.
 *
 * ⚠️ RAPPEL, parce que c'est le fichier qu'on ouvrira en cherchant « la liste des membres » :
 * ces deux tables sont un INVENTAIRE D'OBSERVABILITÉ, jamais une source d'autorisation. Aucun
 * événement Slack ne les invalide (`member_joined_channel` / `member_left_channel` ne sont pas
 * abonnés) : elles sont fausses et silencieuses dès qu'une personne quitte un canal entre deux
 * synchronisations. Voir l'en-tête de `domain/entities/slack-channel.ts`.
 *
 * ⚠️ Les tables `slack_channels` et `slack_channel_members` ne sont PAS créées par les
 * migrations `drizzle/` : celles-ci sont désynchronisées de `schema.ts`, et `drizzle-kit push`
 * se bloque indéfiniment contre une base `libsql://` distante. Le DDL
 * (`scripts/ddl-slack-channels.sql`) doit être appliqué à la main sur toute base neuve ou de
 * production, comme pour `conversation_turns`, `slack_event_dedup` et `slack_directory`.
 */

/**
 * Taille des paquets d'insertion.
 *
 * SQLite plafonne le nombre de paramètres liés d'un énoncé (999 par défaut). Une insertion
 * multi-lignes porte 4 colonnes par membre : au-delà de ~240 membres, un `INSERT` unique
 * dépasserait la borne et échouerait sur les canaux les plus peuplés — c'est-à-dire exactement
 * ceux pour lesquels l'inventaire a de la valeur. 100 laisse une marge confortable et garde le
 * nombre d'allers-retours bas.
 */
const MEMBER_INSERT_CHUNK = 100;

export class DrizzleChannelInventoryRepository implements ChannelInventoryRepository {
  /**
   * Connexion résolue PARESSEUSEMENT (fonction, pas instance) : la construire ici ouvrirait la
   * base au chargement du module. Le paramètre existe pour les tests, qui injectent une base
   * libsql en mémoire plutôt que de mocker Drizzle à la main.
   */
  constructor(private readonly resolveDb: () => DatabaseInstance = getDb) {}

  async upsertChannel(facts: SlackChannelFacts, now: Date): Promise<void> {
    const db = this.resolveDb();

    await db
      .insert(slackChannels)
      .values({
        channelId: facts.channelId,
        name: facts.name,
        isPrivate: facts.isPrivate,
        isArchived: facts.isArchived,
        isMember: facts.isMember,
        memberCountReported: facts.memberCountReported,
        syncedAt: now,
      })
      .onConflictDoUpdate({
        target: slackChannels.channelId,
        // Champs énumérés UN À UN, comme dans `upsertFacts` de l'annuaire. `channel_id` est
        // absent : c'est la cible du conflit. `member_count_reported` est réécrit tel quel,
        // `null` compris — un `COALESCE` avec l'ancienne valeur conserverait une assertion
        // périmée en la faisant passer pour actuelle.
        set: {
          name: facts.name,
          isPrivate: facts.isPrivate,
          isArchived: facts.isArchived,
          isMember: facts.isMember,
          memberCountReported: facts.memberCountReported,
          syncedAt: now,
        },
      });
  }

  /**
   * REMPLACEMENT en deux temps, et l'ORDRE porte toute la sûreté :
   *
   *   1. on marque les membres présents (`INSERT … ON CONFLICT DO UPDATE SET synced_at`) ;
   *   2. **ensuite seulement**, on supprime du canal ce qui porte encore un `synced_at`
   *      antérieur — donc ce qui n'a pas été revu.
   *
   * Faire l'inverse (purger puis réinsérer) perdrait `first_seen_at` sur TOUT LE MONDE à chaque
   * passage, et une interruption entre les deux laisserait le canal vide. Ici, une interruption
   * pendant la phase 1 lève avant la suppression : rien n'est perdu, la passe suivante reprend.
   *
   * `first_seen_at` n'est JAMAIS nommé dans le `set` — même contrat que `dm_channel_id` dans
   * `upsertFacts`, et même mode d'échec évité que `documents.content`.
   *
   * `lt` et non `ne` sur la suppression : une passe concurrente plus récente aurait écrit un
   * `synced_at` postérieur, et l'égalité stricte inversée effacerait son travail.
   */
  async replaceMembers(
    channelId: string,
    slackUserIds: readonly string[],
    now: Date,
  ): Promise<void> {
    const db = this.resolveDb();

    // Dédoublonnage défensif : `conversations.members` peut rendre deux fois le même
    // identifiant à cheval sur deux pages. Sans lui, l'`INSERT` multi-lignes lèverait
    // `ON CONFLICT DO UPDATE command cannot affect row a second time` — un échec de la passe
    // entière pour une redite bénigne de l'API.
    const unique = [...new Set(slackUserIds)];

    for (let i = 0; i < unique.length; i += MEMBER_INSERT_CHUNK) {
      const chunk = unique.slice(i, i + MEMBER_INSERT_CHUNK);

      await db
        .insert(slackChannelMembers)
        .values(
          chunk.map((slackUserId) => ({
            channelId,
            slackUserId,
            firstSeenAt: now,
            syncedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [slackChannelMembers.channelId, slackChannelMembers.slackUserId],
          // `first_seen_at` ABSENT du `set`, et c'est le point critique de ce fichier.
          set: { syncedAt: now },
        });
    }

    await db
      .delete(slackChannelMembers)
      .where(
        and(eq(slackChannelMembers.channelId, channelId), lt(slackChannelMembers.syncedAt, now)),
      );
  }

  /** Tri explicite : sans `ORDER BY`, deux appels identiques peuvent rendre deux ordres. */
  async listChannels(): Promise<SlackChannelRecord[]> {
    const db = this.resolveDb();
    const rows = await db.select().from(slackChannels).orderBy(asc(slackChannels.channelId));
    return rows.map(toChannel);
  }

  /**
   * `LEFT JOIN` et non `INNER` : un canal sans aucun membre observé doit apparaître avec un
   * compte de 0. Un `INNER JOIN` le ferait DISPARAÎTRE du rapport, et « absent » se lirait
   * « pas de problème » — alors qu'un canal connu sans membre observé est précisément ce qu'il
   * faut voir.
   */
  async listInventory(): Promise<SlackChannelInventoryEntry[]> {
    const db = this.resolveDb();

    const rows = await db
      .select({
        channelId: slackChannels.channelId,
        name: slackChannels.name,
        isPrivate: slackChannels.isPrivate,
        isArchived: slackChannels.isArchived,
        isMember: slackChannels.isMember,
        memberCountReported: slackChannels.memberCountReported,
        syncedAt: slackChannels.syncedAt,
        // `count(colonne)` et non `count(*)` : sur un `LEFT JOIN` sans correspondance, `count(*)`
        // rendrait 1 (la ligne de gauche existe), donc un canal vide serait rapporté à 1 membre.
        observedMemberCount: count(slackChannelMembers.slackUserId),
      })
      .from(slackChannels)
      .leftJoin(slackChannelMembers, eq(slackChannelMembers.channelId, slackChannels.channelId))
      .groupBy(slackChannels.channelId)
      .orderBy(asc(slackChannels.channelId));

    return rows.map((row) => ({
      channel: toChannel(row),
      observedMemberCount: Number(row.observedMemberCount),
    }));
  }

  async listObservedMembers(channelId: string): Promise<SlackChannelMembership[]> {
    const db = this.resolveDb();

    const rows = await db
      .select()
      .from(slackChannelMembers)
      .where(eq(slackChannelMembers.channelId, channelId))
      .orderBy(asc(slackChannelMembers.slackUserId));

    return rows.map(toMembership);
  }

  async listChannelsObservedForUser(slackUserId: string): Promise<SlackChannelMembership[]> {
    const db = this.resolveDb();

    const rows = await db
      .select()
      .from(slackChannelMembers)
      .where(eq(slackChannelMembers.slackUserId, slackUserId))
      .orderBy(asc(slackChannelMembers.channelId));

    return rows.map(toMembership);
  }
}

function toChannel(row: Omit<SlackChannelRow, never>): SlackChannelRecord {
  return {
    channelId: row.channelId,
    name: row.name,
    isPrivate: row.isPrivate,
    isArchived: row.isArchived,
    isMember: row.isMember,
    memberCountReported: row.memberCountReported ?? null,
    syncedAt: row.syncedAt,
  };
}

function toMembership(row: SlackChannelMemberRow): SlackChannelMembership {
  return {
    channelId: row.channelId,
    slackUserId: row.slackUserId,
    firstSeenAt: row.firstSeenAt,
    syncedAt: row.syncedAt,
  };
}

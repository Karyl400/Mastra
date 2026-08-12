import type {
  SlackChannelFacts,
  SlackChannelInventoryEntry,
  SlackChannelMembership,
  SlackChannelRecord,
} from '../../domain/entities/slack-channel';
import type { ChannelInventoryRepository } from '../../domain/ports/channel.repository';

/**
 * Doublure de test de l'inventaire des canaux.
 *
 * ⚠️ Elle doit reproduire EXACTEMENT deux propriétés de l'implémentation Drizzle, sans quoi elle
 * validerait en test un comportement que la production n'a pas :
 *
 *  1. `replaceMembers` REMPLACE — une personne absente de la liste disparaît ;
 *  2. `first_seen_at` SURVIT pour une personne toujours présente.
 *
 * Les deux implémentations sont donc exercées par la MÊME suite de tests, comme pour
 * `DirectoryRepository`. Une doublure plus permissive laisserait passer précisément le défaut
 * que ce port existe pour interdire.
 *
 * ⚠️ Inventaire d'observabilité — jamais une source d'autorisation. Voir
 * `domain/entities/slack-channel.ts`.
 */
export class InMemoryChannelInventoryRepository implements ChannelInventoryRepository {
  private channels = new Map<string, SlackChannelRecord>();
  /** Clé `channelId` → membres par `slackUserId`. */
  private members = new Map<string, Map<string, SlackChannelMembership>>();

  async upsertChannel(facts: SlackChannelFacts, now: Date): Promise<void> {
    this.channels.set(facts.channelId, {
      channelId: facts.channelId,
      name: facts.name,
      isPrivate: facts.isPrivate,
      isArchived: facts.isArchived,
      isMember: facts.isMember,
      // Réécrit tel quel, `null` compris : conserver l'ancienne valeur ferait passer une
      // assertion périmée pour actuelle.
      memberCountReported: facts.memberCountReported,
      syncedAt: now,
    });
  }

  async replaceMembers(
    channelId: string,
    slackUserIds: readonly string[],
    now: Date,
  ): Promise<void> {
    const previous = this.members.get(channelId) ?? new Map<string, SlackChannelMembership>();
    const next = new Map<string, SlackChannelMembership>();

    for (const slackUserId of new Set(slackUserIds)) {
      next.set(slackUserId, {
        channelId,
        slackUserId,
        // Le fait que NOUS accumulons — jamais réécrit par une resynchronisation.
        firstSeenAt: previous.get(slackUserId)?.firstSeenAt ?? now,
        syncedAt: now,
      });
    }

    // Remplacement, pas fusion : ce qui n'est pas dans `next` a disparu.
    this.members.set(channelId, next);
  }

  async listChannels(): Promise<SlackChannelRecord[]> {
    return [...this.channels.values()].sort((a, b) => compareBinary(a.channelId, b.channelId));
  }

  async listInventory(): Promise<SlackChannelInventoryEntry[]> {
    const channels = await this.listChannels();
    return channels.map((channel) => ({
      channel,
      observedMemberCount: this.members.get(channel.channelId)?.size ?? 0,
    }));
  }

  async listObservedMembers(channelId: string): Promise<SlackChannelMembership[]> {
    const rows = [...(this.members.get(channelId)?.values() ?? [])];
    return rows.sort((a, b) => compareBinary(a.slackUserId, b.slackUserId));
  }

  async listChannelsObservedForUser(slackUserId: string): Promise<SlackChannelMembership[]> {
    const rows: SlackChannelMembership[] = [];
    for (const byUser of this.members.values()) {
      const hit = byUser.get(slackUserId);
      if (hit) rows.push(hit);
    }
    return rows.sort((a, b) => compareBinary(a.channelId, b.channelId));
  }

  /** Confort de test : vide l'inventaire entre deux cas. */
  clear(): void {
    this.channels.clear();
    this.members.clear();
  }
}

/**
 * Comparaison BINAIRE, celle de l'`ORDER BY` de SQLite sur une colonne `text`. `localeCompare`
 * s'en écarterait, et deux implémentations qui trient différemment finiraient par faire diverger
 * un test de la production sur un détail que personne ne relit.
 */
function compareBinary(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

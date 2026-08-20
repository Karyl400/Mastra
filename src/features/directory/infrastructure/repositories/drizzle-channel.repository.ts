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

const MEMBER_INSERT_CHUNK = 100;

export class DrizzleChannelInventoryRepository implements ChannelInventoryRepository {
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

  async replaceMembers(
    channelId: string,
    slackUserIds: readonly string[],
    now: Date,
  ): Promise<void> {
    const db = this.resolveDb();

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
          set: { syncedAt: now },
        });
    }

    await db
      .delete(slackChannelMembers)
      .where(
        and(eq(slackChannelMembers.channelId, channelId), lt(slackChannelMembers.syncedAt, now)),
      );
  }

  async listChannels(): Promise<SlackChannelRecord[]> {
    const db = this.resolveDb();
    const rows = await db.select().from(slackChannels).orderBy(asc(slackChannels.channelId));
    return rows.map(toChannel);
  }

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

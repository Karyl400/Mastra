import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb, type DatabaseInstance } from '../../../../infrastructure/database/connection';
import { slackDirectory, type SlackDirectoryRow } from '../../../../infrastructure/database/schema';
import type { DirectoryMember, DirectoryMemberFacts } from '../../domain/entities/directory-member';
import type { DirectoryRepository } from '../../domain/ports/directory.repository';
import { matchesName } from '../../../../shared/name-matching';
import { EmployeeRole, isManagerRole } from '../../../../shared/types';

export class DrizzleDirectoryRepository implements DirectoryRepository {
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

  async rememberDmChannel(slackUserId: string, dmChannelId: string): Promise<void> {
    const db = this.resolveDb();

    await db
      .update(slackDirectory)
      .set({ dmChannelId })
      .where(and(eq(slackDirectory.slackUserId, slackUserId), isNull(slackDirectory.dmChannelId)));
  }

  async hasManager(): Promise<boolean> {
    const db = this.resolveDb();
    const row = await db
      .select({ id: slackDirectory.slackUserId })
      .from(slackDirectory)
      .where(
        and(
          eq(slackDirectory.role, EmployeeRole.Manager),
          eq(slackDirectory.isDeleted, false),
          eq(slackDirectory.isBot, false),
        ),
      )
      .limit(1)
      .get();

    return row !== undefined;
  }

  async findManagers(): Promise<DirectoryMember[]> {
    const db = this.resolveDb();
    const rows = await db
      .select()
      .from(slackDirectory)
      .where(
        and(
          eq(slackDirectory.role, EmployeeRole.Manager),
          eq(slackDirectory.isDeleted, false),
          eq(slackDirectory.isBot, false),
        ),
      )
      .orderBy(slackDirectory.slackUserId);

    return rows.map(toDomain);
  }

  async linkEmployee(slackUserId: string, employeeId: string | null): Promise<number> {
    const db = this.resolveDb();

    const result = await db
      .update(slackDirectory)
      .set({ employeeId })
      .where(eq(slackDirectory.slackUserId, slackUserId));

    return Number((result as { rowsAffected?: number }).rowsAffected ?? 0);
  }

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
    isManager: isManagerRole(row.role),
    firstSeenAt: row.firstSeenAt,
    syncedAt: row.syncedAt,
  };
}

import type { DirectoryMember, DirectoryMemberFacts } from '../../domain/entities/directory-member';
import type { DirectoryRepository } from '../../domain/ports/directory.repository';
import { matchesName } from '../../../../shared/name-matching';

export class InMemoryDirectoryRepository implements DirectoryRepository {
  private rows = new Map<string, DirectoryMember>();

  async findBySlackUserId(slackUserId: string): Promise<DirectoryMember | null> {
    return this.rows.get(slackUserId) ?? null;
  }

  async findByEmail(email: string): Promise<DirectoryMember | null> {
    const needle = email.trim();
    if (!needle) return null;

    for (const member of this.rows.values()) {
      if (member.email === needle) return member;
    }

    const lowered = needle.toLowerCase();
    for (const member of this.rows.values()) {
      if (member.email !== null && member.email.toLowerCase() === lowered) return member;
    }

    return null;
  }

  async upsertFacts(facts: DirectoryMemberFacts, now: Date): Promise<void> {
    const previous = this.rows.get(facts.slackUserId);

    this.rows.set(facts.slackUserId, {
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

      dmChannelId: previous?.dmChannelId ?? null,
      employeeId: previous?.employeeId ?? null,
      isManager: previous?.isManager ?? false,
      firstSeenAt: previous?.firstSeenAt ?? now,

      syncedAt: now,
    });
  }

  async rememberDmChannel(slackUserId: string, dmChannelId: string): Promise<void> {
    const existing = this.rows.get(slackUserId);
    if (!existing || existing.dmChannelId !== null) return;

    this.rows.set(slackUserId, { ...existing, dmChannelId });
  }

  async linkEmployee(slackUserId: string, employeeId: string | null): Promise<number> {
    const row = this.rows.get(slackUserId);
    if (!row) return 0;
    this.rows.set(slackUserId, { ...row, employeeId });
    return 1;
  }

  async hasManager(): Promise<boolean> {
    for (const member of this.rows.values()) {
      if (member.isManager && !member.isDeleted && !member.isBot) return true;
    }
    return false;
  }

  async findManagers(): Promise<DirectoryMember[]> {
    return [...this.rows.values()]
      .filter((m) => m.isManager && !m.isDeleted && !m.isBot)
      .sort((a, b) => a.slackUserId.localeCompare(b.slackUserId));
  }

  setRole(slackUserId: string, isManager: boolean): void {
    const row = this.rows.get(slackUserId);
    if (!row) return;
    this.rows.set(slackUserId, { ...row, isManager });
  }

  async findByName(query: string, limit: number): Promise<DirectoryMember[]> {
    if (limit <= 0) return [];

    return Array.from(this.rows.values())
      .sort((a, b) => compareBinary(a.slackUserId, b.slackUserId))
      .filter((m) => matchesName(query, [m.firstName, m.lastName, m.displayName, m.realName]))
      .slice(0, limit);
  }

  async listAll(): Promise<DirectoryMember[]> {
    return Array.from(this.rows.values()).sort((a, b) =>
      compareBinary(a.slackUserId, b.slackUserId),
    );
  }

  clear(): void {
    this.rows.clear();
  }
}

function compareBinary(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

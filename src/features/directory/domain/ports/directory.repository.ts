import type { DirectoryMember, DirectoryMemberFacts } from '../entities/directory-member';

export interface DirectoryRepository {
  findBySlackUserId(slackUserId: string): Promise<DirectoryMember | null>;

  findByEmail(email: string): Promise<DirectoryMember | null>;

  findByName(query: string, limit: number): Promise<DirectoryMember[]>;

  upsertFacts(facts: DirectoryMemberFacts, now: Date): Promise<void>;

  rememberDmChannel(slackUserId: string, dmChannelId: string): Promise<void>;

  hasManager(): Promise<boolean>;

  findManagers(): Promise<DirectoryMember[]>;

  linkEmployee(slackUserId: string, employeeId: string | null): Promise<number>;

  findAll(): Promise<DirectoryMember[]>;
}

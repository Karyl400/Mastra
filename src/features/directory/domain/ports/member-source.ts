import type { DirectoryMemberFacts } from '../entities/directory-member';

export interface MemberSource {
  fetchById(slackUserId: string): Promise<DirectoryMemberFacts | null>;

  fetchAll(): Promise<DirectoryMemberFacts[]>;
}

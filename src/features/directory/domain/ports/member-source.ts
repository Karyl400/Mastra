import type { DirectoryMemberFacts } from '../entities/directory-member';

export interface MemberSource {
  findById(slackUserId: string): Promise<DirectoryMemberFacts | null>;

  findAll(): Promise<DirectoryMemberFacts[]>;
}

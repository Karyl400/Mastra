import type { DirectoryMemberFacts } from '../../domain/entities/directory-member';
import type { MemberSource } from '../../domain/ports/member-source';
import type {
  SlackMember,
  SlackMemberPage,
} from '../../../notification/domain/ports/slack-workspace.port';
import { SLACK_MAX_PAGES } from '../../../notification/domain/ports/slack-workspace.port';
import { logger } from '../../../../shared/logger';

export interface SlackMemberReader {
  listMembersPage(cursor?: string, limit?: number): Promise<SlackMemberPage>;
  findUserById(userId: string): Promise<SlackMember | null>;
}

export interface SlackMemberSourceOptions {
  readonly maxPages?: number;
}

function toFacts(member: SlackMember): DirectoryMemberFacts {
  return {
    slackUserId: member.id,
    teamId: member.teamId,
    email: member.email,
    realName: member.realName,
    displayName: member.displayName,
    firstName: member.firstName || null,
    lastName: member.lastName || null,
    title: member.title || null,
    isBot: member.isBot,
    isAdmin: member.isAdmin,
    isRestricted: member.isRestricted,
    isUltraRestricted: member.isUltraRestricted,
    isDeleted: member.isDeleted,
  };
}

export class SlackMemberSource implements MemberSource {
  private readonly maxPages: number;

  private truncated = false;

  constructor(
    private readonly slack: SlackMemberReader,
    options: SlackMemberSourceOptions = {},
  ) {
    this.maxPages = options.maxPages ?? SLACK_MAX_PAGES;
  }

  async findById(slackUserId: string): Promise<DirectoryMemberFacts | null> {
    const member = await this.slack.findUserById(slackUserId);
    if (!member || !member.id) return null;

    return toFacts(member);
  }

  async findAll(): Promise<DirectoryMemberFacts[]> {
    const facts: DirectoryMemberFacts[] = [];
    let cursor: string | undefined;
    let pages = 0;
    let skipped = 0;

    this.truncated = false;

    do {
      const page = await this.slack.listMembersPage(cursor);

      for (const member of page.members) {
        if (!member.id) {
          skipped += 1;
          continue;
        }
        facts.push(toFacts(member));
      }

      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < this.maxPages);

    if (cursor) {
      this.truncated = true;
      logger.error('Directory member scan TRUNCATED — the workspace was not fully read', {
        pages,
        collected: facts.length,
        cap: this.maxPages,
      });
    }

    if (skipped > 0) {
      logger.warn('Slack members skipped — no user id', { skipped });
    }

    logger.info('Directory member scan completed', {
      collected: facts.length,
      pages,
      truncated: this.truncated,
    });

    return facts;
  }

  wasLastFetchTruncated(): boolean {
    return this.truncated;
  }
}

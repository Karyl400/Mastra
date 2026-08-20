import type {
  ChannelAccessSource,
  ChannelJoinResult,
  ChannelMemberScan,
  ChannelSnapshot,
} from '../../application/services/channel-coverage.service';
import type {
  SlackChannelMembershipPage,
  SlackJoinOutcome,
} from '../../../notification/infrastructure/providers/slack-workspace.service';
import {
  SLACK_MAX_PAGES,
  SLACK_PAGE_LIMIT,
} from '../../../notification/infrastructure/providers/slack-workspace.service';
import { logger } from '../../../../shared/logger';

export interface SlackChannelReader {
  listChannelMembershipsPage(cursor?: string, limit?: number): Promise<SlackChannelMembershipPage>;
  joinChannel(channelId: string): Promise<SlackJoinOutcome>;

  listChannels(): Promise<readonly { id: string; memberCount: number }[]>;

  getChannelMembers(channelId: string): Promise<readonly string[]>;
}

export interface SlackChannelAccessOptions {
  readonly maxPages?: number;

  readonly reportedMemberCounts?: boolean;
}

export const MEMBER_SCAN_CAP = SLACK_MAX_PAGES * SLACK_PAGE_LIMIT;

export class SlackChannelAccess implements ChannelAccessSource {
  private readonly maxPages: number;
  private readonly reportedMemberCounts: boolean;

  constructor(
    private readonly slack: SlackChannelReader,
    options: SlackChannelAccessOptions = {},
  ) {
    this.maxPages = options.maxPages ?? SLACK_MAX_PAGES;
    this.reportedMemberCounts = options.reportedMemberCounts ?? false;
  }

  async listChannels(): Promise<{ channels: ChannelSnapshot[]; truncated: boolean }> {
    const reported = await this.readReportedMemberCounts();

    const channels: ChannelSnapshot[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const page = await this.slack.listChannelMembershipsPage(cursor);

      for (const channel of page.channels) {
        if (!channel.id) continue;

        const count = reported.get(channel.id);

        channels.push({
          id: channel.id,
          name: channel.name,
          isPrivate: channel.isPrivate,
          isArchived: channel.isArchived,
          isMember: channel.isMember,
          ...(count === undefined ? {} : { memberCountReported: count }),
        });
      }

      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < this.maxPages);

    const truncated = Boolean(cursor);
    if (truncated) {
      logger.error('Slack channel scan TRUNCATED — some channels were never considered', {
        pages,
        collected: channels.length,
        cap: this.maxPages,
      });
    }

    return { channels, truncated };
  }

  async join(channelId: string): Promise<ChannelJoinResult> {
    const outcome = await this.slack.joinChannel(channelId);
    return { status: outcome.status, error: outcome.error };
  }

  async listMembers(channelId: string): Promise<ChannelMemberScan> {
    const collected = await this.slack.getChannelMembers(channelId);

    const memberIds = collected.filter(Boolean);

    if (memberIds.length >= MEMBER_SCAN_CAP) {
      logger.error('Slack channel member scan TRUNCATED — some members were never recorded', {
        channelId,
        collected: memberIds.length,
        cap: MEMBER_SCAN_CAP,
      });
      return { memberIds: memberIds.slice(0, MEMBER_SCAN_CAP), truncated: true };
    }

    return { memberIds, truncated: false };
  }

  private async readReportedMemberCounts(): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (!this.reportedMemberCounts) return counts;

    try {
      for (const channel of await this.slack.listChannels()) {
        if (!channel.id) continue;
        if (channel.memberCount > 0) counts.set(channel.id, channel.memberCount);
      }
    } catch (error) {
      logger.warn('Reported member counts unavailable — the inventory will record null', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return counts;
  }
}

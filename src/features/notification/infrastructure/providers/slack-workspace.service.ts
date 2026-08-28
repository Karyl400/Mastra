import { WebClient } from '@slack/web-api';
import type {
  SlackWorkspaceProvider,
  SlackChannel,
  SlackMember,
  SlackMemberPage,
  SlackChannelMembershipPage,
  SlackJoinOutcome,
} from '../../domain/ports/slack-workspace.port';
import { SLACK_PAGE_LIMIT, SLACK_MAX_PAGES } from '../../domain/ports/slack-workspace.port';
import { logger } from '../../../../shared/logger';
import { slackErrorMentions } from '../../../../shared/slack/slack-error';
import { logTruncation, toMember } from './slack-member-mapping';
import { mapJoinFailure } from './slack-join-outcome';

export class SlackWorkspaceService implements SlackWorkspaceProvider {
  private client: WebClient;

  constructor(botToken: string) {
    this.client = new WebClient(botToken);
  }

  async listChannels(): Promise<SlackChannel[]> {
    const channels: SlackChannel[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const response = await this.client.conversations.list({
        types: 'public_channel,private_channel',
        limit: SLACK_PAGE_LIMIT,
        cursor,
      });

      for (const ch of response.channels ?? []) {
        channels.push({
          id: ch.id ?? '',
          name: ch.name ?? '',
          isPrivate: ch.is_private ?? false,
          memberCount: ch.num_members ?? 0,
          topic: ch.topic?.value ?? '',
          purpose: ch.purpose?.value ?? '',
        });
      }

      cursor = response.response_metadata?.next_cursor || undefined;
      pages += 1;
    } while (cursor && pages < SLACK_MAX_PAGES);

    if (cursor) logTruncation('conversations.list', pages, channels.length);

    logger.info('Slack channels discovered', { count: channels.length });
    return channels;
  }

  async listMembers(): Promise<SlackMember[]> {
    const members: SlackMember[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const page = await this.listMembersPage(cursor);

      for (const member of page.members) {
        if (member.isDeleted) continue;
        members.push(member);
      }

      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < SLACK_MAX_PAGES);

    if (cursor) logTruncation('users.list', pages, members.length);

    logger.info('Slack members discovered', { count: members.length });
    return members;
  }

  async listMembersPage(
    cursor?: string,
    limit: number = SLACK_PAGE_LIMIT,
  ): Promise<SlackMemberPage> {
    const response = await this.client.users.list({ limit, cursor });

    return {
      members: (response.members ?? []).map(toMember),
      nextCursor: response.response_metadata?.next_cursor || undefined,
    };
  }

  async listChannelMembershipsPage(
    cursor?: string,
    limit: number = SLACK_PAGE_LIMIT,
  ): Promise<SlackChannelMembershipPage> {
    const response = await this.client.conversations.list({
      types: 'public_channel,private_channel',
      limit,
      cursor,
    });

    return {
      channels: (response.channels ?? []).map((ch) => ({
        id: ch.id ?? '',
        name: ch.name ?? '',
        isPrivate: ch.is_private ?? false,
        isArchived: ch.is_archived ?? false,
        isMember: ch.is_member ?? false,
      })),
      nextCursor: response.response_metadata?.next_cursor || undefined,
    };
  }

  async joinChannel(channelId: string): Promise<SlackJoinOutcome> {
    try {
      const response = await this.client.conversations.join({ channel: channelId });

      const warning = String((response as { warning?: string }).warning ?? '');
      if (warning.includes('already_in_channel')) return { status: 'already_member' };

      logger.info('Joined Slack channel', { channelId });
      return { status: 'joined' };
    } catch (err: unknown) {
      return mapJoinFailure(err, channelId);
    }
  }

  async findUserByEmail(email: string): Promise<SlackMember | null> {
    try {
      const response = await this.client.users.lookupByEmail({ email });
      const user = response.user;
      if (!user) return null;

      return toMember(user);
    } catch (err: unknown) {
      if (slackErrorMentions(err, 'users_not_found')) {
        logger.warn('Slack user not found by email', { email });
        return null;
      }
      throw err;
    }
  }

  async findUserById(userId: string): Promise<SlackMember | null> {
    try {
      const response = await this.client.users.info({ user: userId });
      const user = response.user;
      if (!user) return null;

      return toMember(user);
    } catch (err: unknown) {
      if (slackErrorMentions(err, 'user_not_found') || slackErrorMentions(err, 'users_not_found')) {
        logger.warn('Slack user not found by id', { userId });
        return null;
      }
      throw err;
    }
  }

  async inviteToChannel(channelId: string, userId: string): Promise<void> {
    try {
      await this.client.conversations.invite({
        channel: channelId,
        users: userId,
      });
      logger.info('User invited to Slack channel', { channelId, userId });
    } catch (err: unknown) {
      if (slackErrorMentions(err, 'already_in_channel')) {
        logger.info('User already in channel', { channelId, userId });
        return;
      }
      throw err;
    }
  }

  async getChannelMembers(channelId: string): Promise<string[]> {
    const memberIds: string[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.client.conversations.members({
        channel: channelId,
        limit: 200,
        cursor,
      });

      memberIds.push(...(response.members ?? []));
      cursor = response.response_metadata?.next_cursor || undefined;
    } while (cursor);

    return memberIds;
  }
}

export { toMember } from './slack-member-mapping';
export type { SlackApiUser } from './slack-member-mapping';

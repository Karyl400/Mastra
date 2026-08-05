import { WebClient } from '@slack/web-api';
import type {
  SlackWorkspaceProvider,
  SlackChannel,
  SlackMember,
} from '../../domain/ports/slack-workspace.port';
import { logger } from '../../../../shared/logger';

export class SlackWorkspaceService implements SlackWorkspaceProvider {
  private client: WebClient;

  constructor(botToken: string) {
    this.client = new WebClient(botToken);
  }

  async listChannels(): Promise<SlackChannel[]> {
    const channels: SlackChannel[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.client.conversations.list({
        types: 'public_channel,private_channel',
        limit: 200,
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
    } while (cursor);

    logger.info('Slack channels discovered', { count: channels.length });
    return channels;
  }

  async listMembers(): Promise<SlackMember[]> {
    const members: SlackMember[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.client.users.list({
        limit: 200,
        cursor,
      });

      for (const user of response.members ?? []) {
        if (user.deleted) continue;

        members.push({
          id: user.id ?? '',
          name: user.name ?? '',
          realName: user.real_name ?? '',
          email: user.profile?.email ?? null,
          isBot: user.is_bot ?? false,
          isAdmin: user.is_admin ?? false,
          teamId: user.team_id ?? '',
        });
      }

      cursor = response.response_metadata?.next_cursor || undefined;
    } while (cursor);

    logger.info('Slack members discovered', { count: members.length });
    return members;
  }

  async findUserByEmail(email: string): Promise<SlackMember | null> {
    try {
      const response = await this.client.users.lookupByEmail({ email });
      const user = response.user;
      if (!user) return null;

      return {
        id: user.id ?? '',
        name: user.name ?? '',
        realName: user.real_name ?? '',
        email: user.profile?.email ?? null,
        isBot: user.is_bot ?? false,
        isAdmin: user.is_admin ?? false,
        teamId: user.team_id ?? '',
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('users_not_found')) {
        logger.warn('Slack user not found by email', { email });
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
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('already_in_channel')) {
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

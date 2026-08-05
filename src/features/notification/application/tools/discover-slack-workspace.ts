import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { SlackWorkspaceProvider } from '../../domain/ports/slack-workspace.port';
import { logger } from '../../../../shared/logger';

const slackActionSchema = z.object({
  action: z.enum([
    'listChannels',
    'listMembers',
    'findUserByEmail',
    'inviteToChannel',
    'getChannelMembers',
  ]),
  email: z.string().email().optional(),
  channelId: z.string().optional(),
  userId: z.string().optional(),
});

export function makeDiscoverSlackWorkspace(provider: SlackWorkspaceProvider) {
  return createTool({
    id: 'discoverSlackWorkspace',
    description: `Découvre et gère le workspace Slack de Kisso. Actions disponibles :
- listChannels : liste tous les channels (publics et privés accessibles)
- listMembers : liste tous les membres du workspace
- findUserByEmail : trouve un membre Slack par son adresse email
- inviteToChannel : invite un utilisateur dans un channel (channelId + userId requis)
- getChannelMembers : liste les membres d'un channel spécifique (channelId requis)`,
    inputSchema: slackActionSchema,
    execute: async (data, _ctx) => {
      logger.info('Slack workspace action', { action: data.action });

      switch (data.action) {
        case 'listChannels': {
          const channels = await provider.listChannels();
          return { channels, count: channels.length };
        }
        case 'listMembers': {
          const members = await provider.listMembers();
          const filtered = members.filter((m) => !m.isBot);
          return { members: filtered, count: filtered.length };
        }
        case 'findUserByEmail': {
          if (!data.email) throw new Error('email is required');
          const member = await provider.findUserByEmail(data.email);
          return member ? { found: true, member } : { found: false, member: null };
        }
        case 'inviteToChannel': {
          if (!data.channelId || !data.userId) throw new Error('channelId and userId are required');
          await provider.inviteToChannel(data.channelId, data.userId);
          return { success: true, channelId: data.channelId, userId: data.userId };
        }
        case 'getChannelMembers': {
          if (!data.channelId) throw new Error('channelId is required');
          const memberIds = await provider.getChannelMembers(data.channelId);
          return { channelId: data.channelId, memberIds, count: memberIds.length };
        }
      }
    },
  });
}

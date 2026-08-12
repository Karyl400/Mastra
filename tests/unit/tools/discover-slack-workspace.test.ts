import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeDiscoverSlackWorkspace } from '../../../src/features/notification/application/tools/discover-slack-workspace';
import type {
  SlackWorkspaceProvider,
  SlackChannel,
  SlackMember,
} from '../../../src/features/notification/domain/ports/slack-workspace.port';

const sampleChannel: SlackChannel = {
  id: 'C01',
  name: 'engineering',
  isPrivate: false,
  memberCount: 12,
  topic: 'Tech talk',
  purpose: 'Engineering team',
};

const sampleMember: SlackMember = {
  id: 'U01',
  name: 'jean.dupont',
  realName: 'Jean Dupont',
  email: 'jean.dupont@kisso.com',
  firstName: 'Jean',
  lastName: 'Dupont',
  isBot: false,
  isAdmin: false,
  displayName: '',
  isRestricted: false,
  isUltraRestricted: false,
  isDeleted: false,
  teamId: 'T01',
};

const botMember: SlackMember = {
  id: 'UBOT',
  name: 'kisso-bot',
  realName: 'Kisso Bot',
  email: null,
  firstName: 'Kisso',
  lastName: 'Bot',
  isBot: true,
  isAdmin: false,
  displayName: '',
  isRestricted: false,
  isUltraRestricted: false,
  isDeleted: false,
  teamId: 'T01',
};

function makeMockProvider(overrides: Partial<SlackWorkspaceProvider> = {}): SlackWorkspaceProvider {
  return {
    listChannels: vi.fn().mockResolvedValue([sampleChannel]),
    listMembers: vi.fn().mockResolvedValue([sampleMember, botMember]),
    findUserByEmail: vi.fn().mockResolvedValue(sampleMember),
    getUserById: vi.fn().mockResolvedValue(sampleMember),
    inviteToChannel: vi.fn().mockResolvedValue(undefined),
    getChannelMembers: vi.fn().mockResolvedValue(['U01', 'U02']),
    ...overrides,
  };
}

describe('Tool: discoverSlackWorkspace', () => {
  let provider: SlackWorkspaceProvider;

  beforeEach(() => {
    provider = makeMockProvider();
  });

  it('lists channels via listChannels action', async () => {
    const tool = makeDiscoverSlackWorkspace(provider);
    const result = (await tool.execute!({ action: 'listChannels' } as never, {} as never)) as {
      channels: SlackChannel[];
      count: number;
    };

    expect(result.count).toBe(1);
    expect(result.channels[0]?.name).toBe('engineering');
    expect(provider.listChannels).toHaveBeenCalledTimes(1);
  });

  it('filters bots when listing members', async () => {
    const tool = makeDiscoverSlackWorkspace(provider);
    const result = (await tool.execute!({ action: 'listMembers' } as never, {} as never)) as {
      members: SlackMember[];
      count: number;
    };

    expect(result.count).toBe(1);
    expect(result.members.every((m) => !m.isBot)).toBe(true);
    expect(provider.listMembers).toHaveBeenCalledTimes(1);
  });

  it('finds a user by email', async () => {
    const tool = makeDiscoverSlackWorkspace(provider);
    const result = (await tool.execute!(
      { action: 'findUserByEmail', email: 'jean.dupont@kisso.com' } as never,
      {} as never,
    )) as { found: boolean; member: SlackMember | null };

    expect(result.found).toBe(true);
    expect(result.member?.id).toBe('U01');
    expect(provider.findUserByEmail).toHaveBeenCalledWith('jean.dupont@kisso.com');
  });

  it('returns found=false when email is unknown', async () => {
    provider = makeMockProvider({
      findUserByEmail: vi.fn().mockResolvedValue(null),
    });
    const tool = makeDiscoverSlackWorkspace(provider);

    const result = (await tool.execute!(
      { action: 'findUserByEmail', email: 'unknown@kisso.com' } as never,
      {} as never,
    )) as { found: boolean; member: SlackMember | null };

    expect(result.found).toBe(false);
    expect(result.member).toBeNull();
  });

  it('invites a user to a channel', async () => {
    const tool = makeDiscoverSlackWorkspace(provider);
    const result = (await tool.execute!(
      { action: 'inviteToChannel', channelId: 'C01', userId: 'U01' } as never,
      {} as never,
    )) as { success: boolean; channelId: string; userId: string };

    expect(result.success).toBe(true);
    expect(result.channelId).toBe('C01');
    expect(provider.inviteToChannel).toHaveBeenCalledWith('C01', 'U01');
  });

  it('returns channel members', async () => {
    const tool = makeDiscoverSlackWorkspace(provider);
    const result = (await tool.execute!(
      { action: 'getChannelMembers', channelId: 'C01' } as never,
      {} as never,
    )) as { channelId: string; memberIds: string[]; count: number };

    expect(result.channelId).toBe('C01');
    expect(result.count).toBe(2);
    expect(result.memberIds).toEqual(['U01', 'U02']);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockConversationsList = vi.fn();
const mockUsersList = vi.fn();
const mockLookupByEmail = vi.fn();
const mockConversationsInvite = vi.fn();
const mockConversationsMembers = vi.fn();

vi.mock('@slack/web-api', () => {
  class MockWebClient {
    conversations = {
      list: mockConversationsList,
      invite: mockConversationsInvite,
      members: mockConversationsMembers,
    };
    users = {
      list: mockUsersList,
      lookupByEmail: mockLookupByEmail,
    };
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_token: string) {}
  }

  return { WebClient: MockWebClient };
});

describe('Infrastructure: SlackWorkspaceService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function loadService() {
    const { SlackWorkspaceService } = await import(
      '../../../src/features/notification/infrastructure/providers/slack-workspace.service'
    );
    return new SlackWorkspaceService('xoxb-test-token');
  }

  it('paginates and maps channels', async () => {
    mockConversationsList
      .mockResolvedValueOnce({
        channels: [
          {
            id: 'C01',
            name: 'general',
            is_private: false,
            num_members: 5,
            topic: { value: 'All hands' },
            purpose: { value: 'Company' },
          },
        ],
        response_metadata: { next_cursor: 'page2' },
      })
      .mockResolvedValueOnce({
        channels: [
          {
            id: 'C02',
            name: 'private-hr',
            is_private: true,
            num_members: 2,
            topic: { value: '' },
            purpose: { value: 'HR' },
          },
        ],
        response_metadata: { next_cursor: '' },
      });

    const service = await loadService();
    const channels = await service.listChannels();

    expect(channels).toHaveLength(2);
    expect(channels[0]).toMatchObject({ id: 'C01', name: 'general', isPrivate: false, memberCount: 5 });
    expect(channels[1]).toMatchObject({ id: 'C02', isPrivate: true });
    expect(mockConversationsList).toHaveBeenCalledTimes(2);
  });

  it('skips deleted users when listing members', async () => {
    mockUsersList.mockResolvedValueOnce({
      members: [
        {
          id: 'U01',
          name: 'alice',
          real_name: 'Alice',
          deleted: false,
          is_bot: false,
          is_admin: true,
          team_id: 'T01',
          profile: { email: 'alice@kisso.com' },
        },
        {
          id: 'U02',
          name: 'gone',
          deleted: true,
          profile: {},
        },
      ],
      response_metadata: { next_cursor: '' },
    });

    const service = await loadService();
    const members = await service.listMembers();

    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({
      id: 'U01',
      email: 'alice@kisso.com',
      isAdmin: true,
    });
  });

  it('returns null when lookupByEmail reports users_not_found', async () => {
    mockLookupByEmail.mockRejectedValueOnce(new Error('users_not_found'));

    const service = await loadService();
    const member = await service.findUserByEmail('missing@kisso.com');

    expect(member).toBeNull();
  });

  it('maps a found user by email', async () => {
    mockLookupByEmail.mockResolvedValueOnce({
      user: {
        id: 'U99',
        name: 'bob',
        real_name: 'Bob',
        is_bot: false,
        is_admin: false,
        team_id: 'T01',
        profile: { email: 'bob@kisso.com' },
      },
    });

    const service = await loadService();
    const member = await service.findUserByEmail('bob@kisso.com');

    expect(member).toMatchObject({ id: 'U99', email: 'bob@kisso.com' });
  });

  it('ignores already_in_channel on invite', async () => {
    mockConversationsInvite.mockRejectedValueOnce(new Error('already_in_channel'));

    const service = await loadService();
    await expect(service.inviteToChannel('C01', 'U01')).resolves.toBeUndefined();
  });

  it('rethrows unexpected invite errors', async () => {
    mockConversationsInvite.mockRejectedValueOnce(new Error('channel_not_found'));

    const service = await loadService();
    await expect(service.inviteToChannel('C404', 'U01')).rejects.toThrow('channel_not_found');
  });

  it('paginates channel members', async () => {
    mockConversationsMembers
      .mockResolvedValueOnce({
        members: ['U01'],
        response_metadata: { next_cursor: 'next' },
      })
      .mockResolvedValueOnce({
        members: ['U02'],
        response_metadata: { next_cursor: '' },
      });

    const service = await loadService();
    const ids = await service.getChannelMembers('C01');

    expect(ids).toEqual(['U01', 'U02']);
  });
});

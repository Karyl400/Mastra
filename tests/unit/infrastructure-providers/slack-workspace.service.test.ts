import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockConversationsList = vi.fn();
const mockUsersList = vi.fn();
const mockLookupByEmail = vi.fn();
const mockUsersInfo = vi.fn();
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
      info: mockUsersInfo,
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
    const { SlackWorkspaceService } =
      await import('../../../src/features/notification/infrastructure/providers/slack-workspace.service');
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
    expect(channels[0]).toMatchObject({
      id: 'C01',
      name: 'general',
      isPrivate: false,
      memberCount: 5,
    });
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

  // ── findUserById : résolution d'un membre par son identifiant Slack ──────────
  // Ajouté pour le flux `team_join`, dont le payload ne porte qu'un `user.id`
  // fiable. Rendu sur `SlackWorkspaceProvider` — et non sur `SlackAdapter` —
  // pour réutiliser `SlackMember` : une seconde représentation de l'utilisateur
  // Slack dans la même feature aurait divergé de la première.

  it('maps a user found by id, including first and last name', async () => {
    mockUsersInfo.mockResolvedValueOnce({
      user: {
        id: 'U0BM123',
        name: 'karyl',
        real_name: 'Karyl SOUMAILA',
        is_bot: false,
        is_admin: false,
        team_id: 'TMLKC4EPP',
        profile: {
          email: 'karylsoumaila1@gmail.com',
          first_name: 'Karyl',
          last_name: 'SOUMAILA',
        },
      },
    });

    const service = await loadService();
    const member = await service.findUserById('U0BM123');

    expect(mockUsersInfo).toHaveBeenCalledWith({ user: 'U0BM123' });
    expect(member).toEqual({
      id: 'U0BM123',
      name: 'karyl',
      realName: 'Karyl SOUMAILA',
      email: 'karylsoumaila1@gmail.com',
      firstName: 'Karyl',
      lastName: 'SOUMAILA',
      isBot: false,
      isAdmin: false,
      displayName: 'Karyl SOUMAILA',
      // Le profil de cette réponse ne porte pas de `title` : la projection rend `''`.
      title: '',
      isRestricted: false,
      isUltraRestricted: false,
      isDeleted: false,
      teamId: 'TMLKC4EPP',
    });
  });

  it('falls back to splitting real_name when the profile carries no first/last name', async () => {
    // Cas réel d'un compte fraîchement invité : Slack renseigne `real_name`
    // mais laisse `first_name`/`last_name` vides tant que le profil n'est pas
    // complété. La modale doit malgré tout être pré-remplie.
    mockUsersInfo.mockResolvedValueOnce({
      user: {
        id: 'U0BM124',
        real_name: 'Marie Claire Dupont',
        profile: { email: 'marie@kisso.com' },
      },
    });

    const service = await loadService();
    const member = await service.findUserById('U0BM124');

    expect(member).toMatchObject({ firstName: 'Marie', lastName: 'Claire Dupont' });
  });

  it('returns email null — never an empty string — when the profile has none', async () => {
    // Le flux d'arrivée distingue « pas d'email » (la modale le demandera) de
    // « email vide », qui passerait une simple validation de présence.
    mockUsersInfo.mockResolvedValueOnce({ user: { id: 'U0BM125', profile: {} } });

    const service = await loadService();
    const member = await service.findUserById('U0BM125');

    expect(member?.email).toBeNull();
  });

  it('returns null when users.info reports user_not_found', async () => {
    // Aligné sur `findUserByEmail`, qui absorbe déjà `users_not_found` en null.
    mockUsersInfo.mockRejectedValueOnce(new Error('user_not_found'));

    const service = await loadService();
    await expect(service.findUserById('UINCONNU')).resolves.toBeNull();
  });

  it('rethrows unexpected users.info errors', async () => {
    mockUsersInfo.mockRejectedValueOnce(new Error('ratelimited'));

    const service = await loadService();
    await expect(service.findUserById('U0BM123')).rejects.toThrow('ratelimited');
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

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockConversationsList = vi.fn();
const mockConversationsJoin = vi.fn();

vi.mock('@slack/web-api', () => {
  class MockWebClient {
    conversations = {
      list: mockConversationsList,
      join: mockConversationsJoin,
      invite: vi.fn(),
      members: vi.fn(),
    };
    users = { list: vi.fn(), lookupByEmail: vi.fn(), info: vi.fn() };
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_token: string) {}
  }

  return { WebClient: MockWebClient };
});

/**
 * L'accès aux canaux, du transport Slack jusqu'au port consommé par la couverture.
 *
 * Testé contre un `WebClient` simulé plutôt qu'à travers une doublure de haut niveau : ce qui
 * est en jeu ici est la TRADUCTION des codes d'erreur de Slack en états nommés, et un mock de
 * haut niveau les aurait inventés au lieu de les traduire. Les codes utilisés sont ceux que
 * `conversations.join` retourne réellement.
 */

async function loadService() {
  const { SlackWorkspaceService } =
    await import('../../../src/features/notification/infrastructure/providers/slack-workspace.service');
  return new SlackWorkspaceService('xoxb-test-token');
}

async function loadAccess(maxPages?: number) {
  const { SlackChannelAccess } =
    await import('../../../src/features/directory/infrastructure/providers/slack-channel-access.adapter');
  const service = await loadService();
  return new SlackChannelAccess(service, maxPages === undefined ? {} : { maxPages });
}

describe('Directory: accès aux canaux Slack', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('joinChannel — traduction des refus de Slack', () => {
    it('rend `joined` sur un succès', async () => {
      mockConversationsJoin.mockResolvedValueOnce({ ok: true, channel: { id: 'C1' } });

      await expect((await loadService()).joinChannel('C1')).resolves.toEqual({ status: 'joined' });
    });

    it("rend `already_member` sur l'avertissement, sans exception", async () => {
      // Slack ne lève PAS quand on est déjà dedans : il répond `ok` avec un avertissement.
      mockConversationsJoin.mockResolvedValueOnce({ ok: true, warning: 'already_in_channel' });

      await expect((await loadService()).joinChannel('C1')).resolves.toEqual({
        status: 'already_member',
      });
    });

    it('rend `not_public` sur un canal privé — jamais une exception', async () => {
      mockConversationsJoin.mockRejectedValueOnce(
        new Error('An API error occurred: method_not_supported_for_channel_type'),
      );

      const outcome = await (await loadService()).joinChannel('CPRIV');

      expect(outcome.status).toBe('not_public');
    });

    it('rend `missing_scope` — la seule issue qui appelle un geste humain', async () => {
      mockConversationsJoin.mockRejectedValueOnce(
        new Error('An API error occurred: missing_scope'),
      );

      const outcome = await (await loadService()).joinChannel('C1');

      expect(outcome.status).toBe('missing_scope');
    });

    it('rend `archived` et `not_found` sur leurs codes respectifs', async () => {
      const service = await loadService();

      mockConversationsJoin.mockRejectedValueOnce(new Error('An API error occurred: is_archived'));
      expect((await service.joinChannel('C1')).status).toBe('archived');

      mockConversationsJoin.mockRejectedValueOnce(
        new Error('An API error occurred: channel_not_found'),
      );
      expect((await service.joinChannel('C2')).status).toBe('not_found');
    });

    it("rend `failed` en conservant le code brut d'un refus inattendu", async () => {
      mockConversationsJoin.mockRejectedValueOnce(new Error('An API error occurred: ratelimited'));

      const outcome = await (await loadService()).joinChannel('C1');

      expect(outcome.status).toBe('failed');
      expect(outcome.error).toContain('ratelimited');
    });
  });

  describe('listChannels — pagination', () => {
    it('suit le curseur et projette isMember / isArchived', async () => {
      mockConversationsList
        .mockResolvedValueOnce({
          channels: [
            { id: 'CMLKC4S5T', name: 'kisso-hq', is_private: false, is_member: true },
            { id: 'CMA1TPCN6', name: 'alerts-dev', is_private: false, is_member: false },
          ],
          response_metadata: { next_cursor: 'page2' },
        })
        .mockResolvedValueOnce({
          channels: [
            {
              id: 'COLD',
              name: 'projet-2019',
              is_private: false,
              is_member: false,
              is_archived: true,
            },
          ],
          response_metadata: { next_cursor: '' },
        });

      const { channels, truncated } = await (await loadAccess()).listChannels();

      expect(mockConversationsList).toHaveBeenCalledTimes(2);
      expect(channels).toHaveLength(3);
      expect(channels[0]).toEqual({
        id: 'CMLKC4S5T',
        name: 'kisso-hq',
        isPrivate: false,
        isArchived: false,
        isMember: true,
      });
      expect(channels[2]?.isArchived).toBe(true);
      expect(truncated).toBe(false);
    });

    it("lit `is_member` absent comme « pas membre » — le défaut qui fait TENTER l'adhésion", async () => {
      mockConversationsList.mockResolvedValueOnce({
        channels: [{ id: 'C1', name: 'a', is_private: false }],
        response_metadata: { next_cursor: '' },
      });

      const { channels } = await (await loadAccess()).listChannels();

      // Un `join` inutile est idempotent ; un `postMessage` dans un canal dont on se croit à
      // tort membre échoue en `not_in_channel`, silencieusement.
      expect(channels[0]?.isMember).toBe(false);
    });

    it('AVOUE la troncature quand le plafond de pages est atteint', async () => {
      mockConversationsList.mockResolvedValue({
        channels: [{ id: 'C1', name: 'a', is_private: false, is_member: false }],
        response_metadata: { next_cursor: 'encore' },
      });

      const { channels, truncated } = await (await loadAccess(2)).listChannels();

      expect(mockConversationsList).toHaveBeenCalledTimes(2);
      expect(channels).toHaveLength(2);
      expect(truncated).toBe(true);
    });

    it('écarte un canal sans identifiant', async () => {
      mockConversationsList.mockResolvedValueOnce({
        channels: [
          { name: 'sans-id', is_private: false },
          { id: 'C1', name: 'a' },
        ],
        response_metadata: { next_cursor: '' },
      });

      const { channels } = await (await loadAccess()).listChannels();

      expect(channels.map((c) => c.id)).toEqual(['C1']);
    });
  });

  it("relaie l'issue de join sans la réinterpréter", async () => {
    mockConversationsJoin.mockRejectedValueOnce(new Error('An API error occurred: missing_scope'));

    const result = await (await loadAccess()).join('C1');

    expect(result).toEqual({ status: 'missing_scope', error: 'missing_scope' });
  });
});

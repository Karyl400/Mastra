import { describe, expect, it, vi } from 'vitest';
import {
  makeWelcomeChannels,
  type ChannelInviteResult,
  type WelcomeChannelSource,
} from '../../../src/features/directory/application/services/welcome-channels.service';

const CHANNELS = [
  { id: 'C_HQ', name: 'kisso-hq' },
  { id: 'C_RANDOM', name: 'random' },
];

function makeSource(overrides: Partial<WelcomeChannelSource> = {}): WelcomeChannelSource {
  return {
    listChannels: vi.fn(async () => CHANNELS),
    invite: vi.fn(async (): Promise<ChannelInviteResult> => ({ status: 'invited' })),
    join: vi.fn(async (): Promise<ChannelInviteResult> => ({ status: 'invited' })),
    ...overrides,
  };
}

describe('makeWelcomeChannels', () => {
  it('invite dans chacun des canaux configurés', async () => {
    const source = makeSource();
    const report = await makeWelcomeChannels({
      source,
      channelNames: ['kisso-hq', 'random'],
    }).run('U_NEW');

    expect(report.outcome).toBe('completed');
    expect(report.joinedNames).toEqual(['kisso-hq', 'random']);
    expect(source.invite).toHaveBeenCalledWith('C_HQ', 'U_NEW');
    expect(source.invite).toHaveBeenCalledWith('C_RANDOM', 'U_NEW');
  });

  it("compte `already_in_channel` comme un SUCCÈS — l'objectif est atteint", async () => {
    const source = makeSource({
      invite: vi.fn(async () => ({ status: 'already_in_channel' as const })),
    });
    const report = await makeWelcomeChannels({ source, channelNames: ['random'] }).run('U_NEW');

    expect(report.outcome).toBe('completed');
    expect(report.joinedNames).toEqual(['random']);
    expect(report.failures).toEqual([]);
  });

  it("rejoint le canal puis réessaie quand le bot n'en est pas membre", async () => {
    const invite = vi
      .fn<(channelId: string, userId: string) => Promise<ChannelInviteResult>>()
      .mockResolvedValueOnce({ status: 'bot_not_in_channel' })
      .mockResolvedValueOnce({ status: 'invited' });
    const join = vi.fn(async () => ({ status: 'invited' as const }));
    const source = makeSource({ invite, join });

    const report = await makeWelcomeChannels({ source, channelNames: ['random'] }).run('U_NEW');

    expect(join).toHaveBeenCalledWith('C_RANDOM');
    expect(invite).toHaveBeenCalledTimes(2);
    expect(report.joinedNames).toEqual(['random']);
  });

  it("n'essaie jamais deux fois de rejoindre : un échec de join reste un échec", async () => {
    const invite = vi.fn(async () => ({ status: 'bot_not_in_channel' as const }));
    const join = vi.fn(async () => ({ status: 'failed' as const, error: 'boom' }));
    const source = makeSource({ invite, join });

    const report = await makeWelcomeChannels({ source, channelNames: ['random'] }).run('U_NEW');

    expect(invite).toHaveBeenCalledTimes(1);
    expect(report.outcome).toBe('degraded');
    expect(report.failures).toEqual([
      { name: 'random', status: 'bot_not_in_channel', error: 'boom' },
    ]);
  });

  it("un canal introuvable n'empêche pas les autres d'aboutir", async () => {
    const source = makeSource();
    const report = await makeWelcomeChannels({
      source,
      channelNames: ['inconnu', 'random'],
    }).run('U_NEW');

    expect(report.joinedNames).toEqual(['random']);
    expect(report.failures).toEqual([{ name: 'inconnu', status: 'channel_not_found' }]);
    expect(report.outcome).toBe('degraded');
  });

  it("ne fait AUCUN appel Slack quand aucun canal n'est configuré", async () => {
    const source = makeSource();
    const report = await makeWelcomeChannels({ source, channelNames: [] }).run('U_NEW');

    expect(report.outcome).toBe('not_configured');
    expect(source.listChannels).not.toHaveBeenCalled();
    expect(source.invite).not.toHaveBeenCalled();
  });

  it('ne coule pas la boucle quand `listChannels` lève', async () => {
    const source = makeSource({
      listChannels: vi.fn(async () => {
        throw new Error('slack down');
      }),
    });
    const report = await makeWelcomeChannels({ source, channelNames: ['random'] }).run('U_NEW');

    expect(report.outcome).toBe('degraded');
    expect(report.joinedNames).toEqual([]);
    expect(report.failures[0]?.status).toBe('failed');
  });

  it('ne consomme plus un appel par canal après un `missing_scope`', async () => {
    const invite = vi.fn(async () => ({ status: 'missing_scope' as const }));
    const source = makeSource({ invite });

    const report = await makeWelcomeChannels({
      source,
      channelNames: ['kisso-hq', 'random'],
    }).run('U_NEW');

    expect(invite).toHaveBeenCalledTimes(1);
    expect(report.failures).toHaveLength(2);
    expect(report.outcome).toBe('degraded');
  });

  it('résout les noms sans tenir compte de la casse rendue par Slack', async () => {
    const source = makeSource({
      listChannels: vi.fn(async () => [{ id: 'C_HQ', name: 'Kisso-HQ' }]),
    });
    const report = await makeWelcomeChannels({ source, channelNames: ['kisso-hq'] }).run('U_NEW');

    expect(report.joinedNames).toEqual(['kisso-hq']);
  });
});

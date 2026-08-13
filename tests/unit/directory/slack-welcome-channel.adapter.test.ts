import { describe, expect, it, vi } from 'vitest';
import { SlackWelcomeChannelSource } from '../../../src/features/directory/infrastructure/providers/slack-welcome-channel.adapter';

function clientWith(inviteError: unknown) {
  return {
    listChannels: vi.fn(async () => [{ id: 'C1', name: 'random' }]),
    inviteToChannel: vi.fn(async () => {
      throw inviteError;
    }),
    joinChannel: vi.fn(async () => ({ status: 'joined' })),
  };
}

function slackError(code: string) {
  return Object.assign(new Error('An API error occurred'), { data: { error: code } });
}

describe('SlackWelcomeChannelSource', () => {
  it('traduit un succès', async () => {
    const client = {
      listChannels: vi.fn(async () => [{ id: 'C1', name: 'random' }]),
      inviteToChannel: vi.fn(async () => undefined),
      joinChannel: vi.fn(async () => ({ status: 'joined' })),
    };
    expect(await new SlackWelcomeChannelSource(client).invite('C1', 'U1')).toEqual({
      status: 'invited',
    });
  });

  it('traduit `already_in_channel`', async () => {
    const source = new SlackWelcomeChannelSource(clientWith(slackError('already_in_channel')));
    expect((await source.invite('C1', 'U1')).status).toBe('already_in_channel');
  });

  it('traduit `not_in_channel` en `bot_not_in_channel`', async () => {
    const source = new SlackWelcomeChannelSource(clientWith(slackError('not_in_channel')));
    expect((await source.invite('C1', 'U1')).status).toBe('bot_not_in_channel');
  });

  it('traduit `channel_not_found`', async () => {
    const source = new SlackWelcomeChannelSource(clientWith(slackError('channel_not_found')));
    expect((await source.invite('C1', 'U1')).status).toBe('channel_not_found');
  });

  it('traduit `missing_scope`', async () => {
    const source = new SlackWelcomeChannelSource(clientWith(slackError('missing_scope')));
    expect((await source.invite('C1', 'U1')).status).toBe('missing_scope');
  });

  it("lit aussi le code d'erreur dans le MESSAGE, faute de champ `data`", async () => {
    const source = new SlackWelcomeChannelSource(
      clientWith(new Error('An API error occurred: already_in_channel')),
    );
    expect((await source.invite('C1', 'U1')).status).toBe('already_in_channel');
  });

  it('rend `failed` avec le message pour tout code inconnu', async () => {
    const source = new SlackWelcomeChannelSource(clientWith(new Error('boom')));
    expect(await source.invite('C1', 'U1')).toEqual({ status: 'failed', error: 'boom' });
  });

  it('traduit les statuts de `joinChannel`, qui ne lève jamais', async () => {
    const make = (status: string) =>
      new SlackWelcomeChannelSource({
        listChannels: vi.fn(async () => []),
        inviteToChannel: vi.fn(async () => undefined),
        joinChannel: vi.fn(async () => ({ status })),
      });

    expect((await make('joined').join('C1')).status).toBe('invited');
    expect((await make('already_member').join('C1')).status).toBe('already_in_channel');
    expect((await make('missing_scope').join('C1')).status).toBe('missing_scope');
    expect((await make('archived').join('C1')).status).toBe('channel_not_found');
    expect((await make('failed').join('C1')).status).toBe('failed');
  });

  it('rend les canaux sous la forme attendue par le service', async () => {
    const source = new SlackWelcomeChannelSource({
      listChannels: vi.fn(async () => [{ id: 'C1', name: 'random' }]),
      inviteToChannel: vi.fn(async () => undefined),
      joinChannel: vi.fn(async () => ({ status: 'joined' })),
    });

    expect(await source.listChannels()).toEqual([{ id: 'C1', name: 'random' }]);
  });
});

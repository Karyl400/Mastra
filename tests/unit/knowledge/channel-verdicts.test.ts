import { describe, it, expect } from 'vitest';
import type { WebClient } from '@slack/web-api';

import { makeGetChannelHistory } from '../../../src/features/knowledge/application/tools/get-channel-history';
import { SlackChannelHistoryAdapter } from '../../../src/features/knowledge/infrastructure/providers/slack-channel-history.adapter';
import { ChannelUnavailableError } from '../../../src/features/knowledge/domain/ports/channel-history.port';
import { InMemoryDirectoryRepository } from '../../../src/features/directory/infrastructure/repositories/in-memory-directory.repository';
import { buildSlackRequestContext } from '../../../src/shared/slack-request-context';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * « JE NE SAIS PAS » N'EST PAS « TU N'ES PAS MEMBRE »
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Symptôme de production, 2026-08-25 : *« Je ne peux pas résumer le canal kisso-hq car je n'en
 * suis pas membre. »* — alors que le bot **EST** membre de kisso-hq, vérifié auprès de Slack
 * (`CMLKC4S5T`, `is_member: true`).
 *
 * ⚠️ **DEUX DÉFAUTS DISTINCTS SE SUPERPOSAIENT, ET LE SECOND MASQUAIT LE PREMIER.**
 *
 * **1. `isMember` avalait TOUTE erreur et rendait `false`.** Mesuré contre la vraie Turso et le
 * vrai workspace :
 *
 *   | canal                            | `conversations.members` | `isMember` rendait |
 *   | -------------------------------- | ----------------------- | ------------------ |
 *   | `CMLKC4S5T` (kisso-hq, réel)     | 200                     | `true`             |
 *   | `C0BMLKC4S5T` (n'existe pas)     | `channel_not_found`     | **`false`**        |
 *
 * Trois faits différents — « la personne n'est pas membre », « cet identifiant ne désigne aucun
 * canal », « Slack n'a pas répondu » — ressortaient donc sous UN seul verdict, et c'était le
 * plus accusateur des trois. Même famille que `no_data_yet` contre `not_persisted` au tableau
 * de bord, et que `null` contre `[]` dans `readToolCalls` : **une absence de preuve n'est pas
 * une preuve d'absence.**
 *
 * ⚠️ La décision d'ACCÈS, elle, ne bouge pas d'un pouce : une appartenance non prouvée vaut
 * toujours NON. Ce qui change est ce qu'on en DIT. Refuser est correct ; en donner une fausse
 * raison ne l'est pas.
 *
 * **2. Le `hint` de `not_channel_member` était une CONSIGNE, pas un FAIT** — *« Tu ne montres un
 * canal qu'à ses membres »*. Le verdict porte sur le DEMANDEUR ; le modèle, n'ayant sous les
 * yeux qu'une phrase à la deuxième personne, l'a reportée sur LUI-MÊME. D'où « je n'en suis pas
 * membre », qui accuse le bot d'un défaut qu'il n'a pas et envoie le diagnostic dans le mur.
 */

const REQUESTER = 'U_REQ';
const CHANNEL = 'C0BJGBVB5HP';

function adapterWith(membersImpl: () => Promise<unknown>): SlackChannelHistoryAdapter {
  const client = { conversations: { members: membersImpl } } as unknown as WebClient;
  return new SlackChannelHistoryAdapter('xoxb-test', { client });
}

function slackError(code: string): Error {
  const error = new Error(`An API error occurred: ${code}`);
  (error as unknown as { data: { error: string } }).data = { error: code };
  return error;
}

describe('l’adaptateur Slack dit POURQUOI il n’a pas pu répondre', () => {
  it('un identifiant qui ne désigne aucun canal LÈVE `channel_not_found`', async () => {
    // ⚠️ Le cas mesuré en production. Rendre `false` ici, c'est accuser quelqu'un d'une absence
    // d'appartenance à un canal qui n'existe pas.
    const adapter = adapterWith(async () => {
      throw slackError('channel_not_found');
    });

    await expect(adapter.isMember('C0BMLKC4S5T', REQUESTER)).rejects.toMatchObject({
      name: 'ChannelUnavailableError',
      reason: 'channel_not_found',
    });
  });

  it('une panne Slack LÈVE `unavailable`', async () => {
    const adapter = adapterWith(async () => {
      throw new Error('socket hang up');
    });

    await expect(adapter.isMember(CHANNEL, REQUESTER)).rejects.toMatchObject({
      reason: 'unavailable',
    });
  });

  it('mais une réponse RÉELLE de Slack reste un verdict d’appartenance, pas une erreur', async () => {
    // L'autre moitié : sans elle, on aurait remplacé un mensonge par une panne permanente.
    const present = adapterWith(async () => ({ members: [REQUESTER, 'U_OTHER'] }));
    const absent = adapterWith(async () => ({ members: ['U_OTHER'] }));

    await expect(present.isMember(CHANNEL, REQUESTER)).resolves.toBe(true);
    await expect(absent.isMember(CHANNEL, REQUESTER)).resolves.toBe(false);
  });
});

describe('le tool rend la VRAIE raison, jamais la plus accusatrice', () => {
  const directory = new InMemoryDirectoryRepository();

  async function run(isMember: () => Promise<boolean>) {
    const tool = makeGetChannelHistory({
      directory,
      channels: {
        isMember,
        fetchRecent: async () => [],
        listMemberChannels: async () => [],
      },
    });

    return (await tool.execute!(
      { channelId: CHANNEL } as never,
      {
        requestContext: buildSlackRequestContext({ channel: 'D0X', slackUserId: REQUESTER }),
      } as never,
    )) as { found: boolean; reason?: string; hint?: string };
  }

  it('un identifiant inconnu ressort en `channel_not_found`, PAS en `not_channel_member`', async () => {
    const result = await run(async () => {
      throw new ChannelUnavailableError('channel_not_found', 'inconnu');
    });

    expect(result.reason).toBe('channel_not_found');
  });

  it('une indisponibilité ressort en `unavailable` — et reste un REFUS', async () => {
    const result = await run(async () => {
      throw new ChannelUnavailableError('unavailable', 'slack down');
    });

    expect(result.found).toBe(false);
    expect(result.reason).toBe('unavailable');
  });

  it('une erreur SANS raison connue reste `unavailable` (fail-closed)', async () => {
    const result = await run(async () => {
      throw new Error('boom');
    });

    expect(result.found).toBe(false);
    expect(result.reason).toBe('unavailable');
  });
});

describe('le hint dit DE QUI il parle', () => {
  const directory = new InMemoryDirectoryRepository();

  it('`not_channel_member` désigne le demandeur et interdit au modèle de se l’attribuer', async () => {
    // ⚠️ C'est la moitié du défaut que la mesure ne pouvait pas montrer : le verdict était juste,
    // sa formulation faisait dire au modèle l'inverse de la vérité.
    const tool = makeGetChannelHistory({
      directory,
      channels: {
        isMember: async () => false,
        fetchRecent: async () => [],
        listMemberChannels: async () => [],
      },
    });

    const result = (await tool.execute!(
      { channelId: CHANNEL } as never,
      {
        requestContext: buildSlackRequestContext({ channel: 'D0X', slackUserId: REQUESTER }),
      } as never,
    )) as { reason?: string; hint?: string };

    expect(result.reason).toBe('not_channel_member');
    expect(result.hint).toMatch(/demande/i);
    expect(result.hint).toMatch(/pas (?:de )?toi|jamais de toi|pas la tienne/i);
  });
});

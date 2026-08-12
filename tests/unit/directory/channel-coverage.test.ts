import { describe, it, expect, vi } from 'vitest';

import {
  makeChannelCoverage,
  type ChannelAccessSource,
  type ChannelJoinResult,
  type ChannelSnapshot,
} from '../../../src/features/directory/application/services/channel-coverage.service';

/**
 * Couverture de canaux — le bot rejoint tout seul les canaux PUBLICS.
 *
 * Contexte mesuré : le scope `channels:join` est accordé, aucun code n'émettait l'appel, le bot
 * était membre de 2 canaux sur 5, et `chat.postMessage` échouait en `not_in_channel` dans les
 * trois autres — silencieusement, le message d'erreur de repli étant posté dans le même canal
 * inaccessible.
 *
 * Trois propriétés sont verrouillées ici :
 *   • un canal PRIVÉ n'est pas une erreur, c'est un état NOMMÉ (il faut une invitation humaine) ;
 *   • rejoindre un canal déjà rejoint est SANS EFFET et sans appel ;
 *   • `missing_scope` interrompt la boucle plutôt que de la répéter N fois.
 */

/** Les 5 canaux réels du workspace Kisso, dans l'état constaté. */
function kissoChannels(): ChannelSnapshot[] {
  return [
    { id: 'CMLKC4S5T', name: 'kisso-hq', isPrivate: false, isArchived: false, isMember: true },
    {
      id: 'C0BJGBVB5HP',
      name: 'engineer-karyl',
      isPrivate: true,
      isArchived: false,
      isMember: true,
    },
    { id: 'CMA1TPCN6', name: 'alerts-dev', isPrivate: false, isArchived: false, isMember: false },
    { id: 'C09TRLL2KEW', name: 'random', isPrivate: false, isArchived: false, isMember: false },
    { id: 'C0AV1B23V0U', name: 'signals', isPrivate: false, isArchived: false, isMember: false },
  ];
}

function makeSource(
  channels: ChannelSnapshot[],
  join: (id: string) => ChannelJoinResult = () => ({ status: 'joined' }),
  truncated = false,
): ChannelAccessSource {
  return {
    listChannels: vi.fn(async () => ({ channels, truncated })),
    join: vi.fn(async (id: string) => join(id)),
  };
}

describe('Directory: couverture de canaux', () => {
  it('rejoint les canaux publics où le bot manque, et expose les Channel ID accessibles', async () => {
    const source = makeSource(kissoChannels());

    const report = await makeChannelCoverage({ source }).run();

    expect(report.joined.map((c) => c.id)).toEqual(['CMA1TPCN6', 'C09TRLL2KEW', 'C0AV1B23V0U']);
    expect(report.alreadyMember).toBe(2);
    // Le livrable demandé : l'accès par Channel ID. Trié, donc stable d'un appel à l'autre.
    expect(report.accessibleChannelIds).toEqual([
      'C09TRLL2KEW',
      'C0AV1B23V0U',
      'C0BJGBVB5HP',
      'CMA1TPCN6',
      'CMLKC4S5T',
    ]);
    expect(report.outcome).toBe('completed');
  });

  it('ne tente RIEN sur un canal privé et le rapporte comme un état nommé', async () => {
    const source = makeSource([
      { id: 'CPRIV', name: 'direction', isPrivate: true, isArchived: false, isMember: false },
    ]);

    const report = await makeChannelCoverage({ source }).run();

    // `conversations.join` ne fonctionne QUE sur un canal public : tenter produirait un échec
    // certain, et compter ce cas comme une dégradation détruirait le signal.
    expect(source.join).not.toHaveBeenCalled();
    expect(report.privateNotMember).toEqual([{ id: 'CPRIV', name: 'direction' }]);
    expect(report.failures).toEqual([]);
    expect(report.outcome).toBe('completed');
  });

  it('garde accessible un canal privé dont le bot EST déjà membre', async () => {
    const source = makeSource([
      {
        id: 'C0BJGBVB5HP',
        name: 'engineer-karyl',
        isPrivate: true,
        isArchived: false,
        isMember: true,
      },
    ]);

    const report = await makeChannelCoverage({ source }).run();

    // « Privé » ne vaut exclusion que combiné à « pas membre ».
    expect(report.accessibleChannelIds).toEqual(['C0BJGBVB5HP']);
    expect(report.privateNotMember).toEqual([]);
  });

  it('est idempotente : un second passage ne rejoint plus rien', async () => {
    const first = makeSource(kissoChannels());
    await makeChannelCoverage({ source: first }).run();

    // Après le premier passage, Slack rapporte le bot comme membre partout.
    const after = kissoChannels().map((c) => ({ ...c, isMember: true }));
    const second = makeSource(after);
    const report = await makeChannelCoverage({ source: second }).run();

    expect(second.join).not.toHaveBeenCalled();
    expect(report.joined).toEqual([]);
    expect(report.alreadyMember).toBe(5);
    expect(report.outcome).toBe('completed');
  });

  it('compte une adhésion concurrente comme déjà membre, pas comme nouvelle', async () => {
    const source = makeSource(
      [{ id: 'C1', name: 'random', isPrivate: false, isArchived: false, isMember: false }],
      () => ({ status: 'already_member' }),
    );

    const report = await makeChannelCoverage({ source }).run();

    // Quelqu'un a invité le bot entre le balayage et l'appel : bénin, mais le rapport ne doit
    // pas prétendre que CE passage a changé quelque chose.
    expect(report.joined).toEqual([]);
    expect(report.alreadyMember).toBe(1);
    expect(report.accessibleChannelIds).toEqual(['C1']);
  });

  it('écarte les canaux archivés sans les compter en échec', async () => {
    const source = makeSource([
      { id: 'COLD', name: 'projet-2019', isPrivate: false, isArchived: true, isMember: false },
    ]);

    const report = await makeChannelCoverage({ source }).run();

    expect(source.join).not.toHaveBeenCalled();
    expect(report.archivedSkipped).toBe(1);
    expect(report.outcome).toBe('completed');
  });

  it('arrête d appeler Slack dès le premier missing_scope, mais nomme tous les canaux en attente', async () => {
    const source = makeSource(
      [
        { id: 'C1', name: 'a', isPrivate: false, isArchived: false, isMember: false },
        { id: 'C2', name: 'b', isPrivate: false, isArchived: false, isMember: false },
        { id: 'C3', name: 'c', isPrivate: false, isArchived: false, isMember: false },
      ],
      () => ({ status: 'missing_scope', error: 'missing_scope' }),
    );

    const report = await makeChannelCoverage({ source }).run();

    // Un seul appel : les deux suivants échoueraient identiquement.
    expect(source.join).toHaveBeenCalledTimes(1);
    expect(report.missingScope).toBe(true);
    expect(report.failures).toHaveLength(3);
    expect(report.outcome).toBe('degraded');
    expect(report.accessibleChannelIds).toEqual([]);
  });

  it("un échec sur un canal n'interrompt pas les autres", async () => {
    const source = makeSource(
      [
        { id: 'C1', name: 'a', isPrivate: false, isArchived: false, isMember: false },
        { id: 'C2', name: 'b', isPrivate: false, isArchived: false, isMember: false },
      ],
      (id) => (id === 'C1' ? { status: 'failed', error: 'ratelimited' } : { status: 'joined' }),
    );

    const report = await makeChannelCoverage({ source }).run();

    expect(report.joined.map((c) => c.id)).toEqual(['C2']);
    expect(report.failures).toEqual([
      { channelId: 'C1', name: 'a', status: 'failed', error: 'ratelimited' },
    ]);
    expect(report.outcome).toBe('degraded');
  });

  it('requalifie en canal privé un not_public rendu par Slack', async () => {
    const source = makeSource(
      [{ id: 'C1', name: 'converti', isPrivate: false, isArchived: false, isMember: false }],
      () => ({ status: 'not_public', error: 'method_not_supported_for_channel_type' }),
    );

    const report = await makeChannelCoverage({ source }).run();

    // Slack contredit `is_private` (canal converti entre-temps) : état nommé, pas dégradation.
    expect(report.privateNotMember).toEqual([{ id: 'C1', name: 'converti' }]);
    expect(report.outcome).toBe('completed');
  });

  it('propage la troncature du balayage comme une dégradation', async () => {
    const source = makeSource(
      [{ id: 'C1', name: 'a', isPrivate: false, isArchived: false, isMember: true }],
      () => ({ status: 'joined' }),
      true,
    );

    const report = await makeChannelCoverage({ source }).run();

    // « 1 canal couvert » sur une liste tronquée se lirait « il n'y a qu'un canal ».
    expect(report.truncated).toBe(true);
    expect(report.outcome).toBe('degraded');
  });

  it('rejoint SÉQUENTIELLEMENT, jamais en salve', async () => {
    let concurrent = 0;
    let peak = 0;
    const source: ChannelAccessSource = {
      listChannels: async () => ({
        channels: Array.from({ length: 4 }, (_, i) => ({
          id: `C${i}`,
          name: `c${i}`,
          isPrivate: false,
          isArchived: false,
          isMember: false,
        })),
        truncated: false,
      }),
      join: async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 1));
        concurrent -= 1;
        return { status: 'joined' as const };
      },
    };

    await makeChannelCoverage({ source }).run();

    // `conversations.join` est plafonné par Slack : une salve se ferait rate-limiter, et le
    // remède produirait le symptôme qu'il vient corriger.
    expect(peak).toBe(1);
  });
});

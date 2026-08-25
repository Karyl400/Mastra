import { describe, it, expect, vi } from 'vitest';

import { makeGetChannelHistory } from '../../../src/features/knowledge/application/tools/get-channel-history';
import type { DigestDeliveryPort } from '../../../src/features/knowledge/domain/ports/digest-delivery.port';
import { CAPABILITY_LOANS } from '../../../src/shared/capability-loans';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LE PRÊT `channelDigest` — on change le format, pas le flux d'information
 * ════════════════════════════════════════════════════════════════════════════
 *
 * « Résume ce canal et donne-le-moi en PDF » n'était servable par AUCUN agent : seul
 * `knowledgeAgent` sait lire un canal, seul `onboardingOrchestrator` sait rendre un document, et
 * les réunir formerait le canal d'exfiltration que `outbound-tool-quarantine.ts` cite mot pour
 * mot. En production, la demande recevait un contournement — *« copie-moi le texte que tu
 * souhaites que je résume »* — c'est-à-dire un report du travail sur l'humain.
 *
 * ⚠️ **CE QUI REND CE PRÊT SÛR TIENT EN UNE PHRASE** : il ne comporte AUCUN destinataire. Le
 * fichier porte exactement les extraits que l'outil avait déjà le droit de rendre en texte,
 * après la MÊME frontière, et il est déposé exactement là où ce texte serait allé. Il n'y a donc
 * rien de nouveau à exfiltrer. Prêter l'OUTIL, à l'inverse, créerait un chemin qui n'existe pas.
 *
 * Ce fichier vérifie les deux moitiés : que le prêt SERT réellement (sinon c'est de la
 * cérémonie), et qu'il ne franchit aucune des trois lignes qui le rendent sûr.
 */

const REQUESTER = 'U0BJBDGTJUD';
const CHANNEL = 'C0BMLKC4S5T';

const ctx = (over: Record<string, unknown> = {}) => ({
  requestContext: {
    get: (key: string) =>
      ({
        slackChannel: 'D0MOCKDM01',
        slackUserId: REQUESTER,
        slackThreadTs: undefined,
        ...over,
      })[key],
    set: vi.fn(),
  },
});

function build(options: { digests?: DigestDeliveryPort; isMember?: boolean } = {}) {
  const tool = makeGetChannelHistory({
    directory: {
      findBySlackUserId: async () => ({
        slackUserId: REQUESTER,
        displayName: 'Karyl',
        realName: 'Karyl S.',
        email: 'k@kisso.com',
        role: 'employee',
      }),
      findByName: async () => [],
    } as never,
    channels: {
      isMember: async () => options.isMember ?? true,
      fetchRecent: async () => [
        {
          authorLabel: 'Karyl',
          text: 'On a décidé de partir sur Postgres.',
          at: new Date(1_787_000_000_000),
        },
        {
          authorLabel: 'Awa',
          text: 'Je bloque sur la migration, échéance jeudi.',
          at: new Date(1_787_000_100_000),
        },
        { authorLabel: 'Nazer', text: 'ok', at: new Date(1_787_000_200_000) },
      ],
    } as never,
    ...(options.digests ? { digests: options.digests } : {}),
  });
  return tool;
}

const spyDelivery = () => {
  const deliver = vi.fn(async () => ({ delivered: true as const, filename: 'canal.pdf' }));
  return { deliver } satisfies DigestDeliveryPort & { deliver: typeof deliver };
};

describe('le prêt SERT — sinon c’est de la cérémonie', () => {
  it('rend le fichier quand on le demande, et le dit', async () => {
    const digests = spyDelivery();
    const tool = build({ digests });

    const result = (await tool.execute!(
      { channelId: CHANNEL, asDocument: true },
      ctx() as never,
    )) as Record<string, unknown>;

    expect(digests.deliver).toHaveBeenCalledTimes(1);
    expect(result.document).toBe('delivered');
  });

  it('ne rend AUCUN fichier quand on ne le demande pas — le défaut reste le texte', async () => {
    const digests = spyDelivery();
    const tool = build({ digests });

    const result = (await tool.execute!({ channelId: CHANNEL }, ctx() as never)) as Record<
      string,
      unknown
    >;

    expect(digests.deliver).not.toHaveBeenCalled();
    expect(result.document).toBeUndefined();
  });

  it('rend TOUJOURS le texte en plus du fichier — le modèle doit pouvoir répondre', async () => {
    // Un fichier sans réponse dans le fil se lit comme un bot muet qui a lâché une pièce jointe.
    const tool = build({ digests: spyDelivery() });

    const result = (await tool.execute!(
      { channelId: CHANNEL, asDocument: true },
      ctx() as never,
    )) as Record<string, unknown>;

    expect(result.found).toBe(true);
    expect(String(result.conversation)).toContain('Postgres');
  });
});

describe('les trois lignes que le prêt ne franchit pas', () => {
  it('LA FRONTIÈRE D’ABORD — un non-membre n’obtient ni texte ni fichier', async () => {
    // La garantie qui compte : le prêt s'exécute APRÈS `authorizeChannelRead`, jamais avant.
    // Un fichier produit puis refusé serait déjà une fuite — il aurait existé.
    const digests = spyDelivery();
    const tool = build({ digests, isMember: false });

    const result = (await tool.execute!(
      { channelId: CHANNEL, asDocument: true },
      ctx() as never,
    )) as Record<string, unknown>;

    expect(result.found).toBe(false);
    expect(result.reason).toBe('not_channel_member');
    expect(digests.deliver).not.toHaveBeenCalled();
  });

  it('SANS DEMANDEUR IDENTIFIÉ, rien ne part', async () => {
    const digests = spyDelivery();
    const tool = build({ digests });

    const result = (await tool.execute!(
      { channelId: CHANNEL, asDocument: true },
      ctx({ slackUserId: undefined }) as never,
    )) as Record<string, unknown>;

    expect(result.found).toBe(false);
    expect(digests.deliver).not.toHaveBeenCalled();
  });

  it('LE DESTINATAIRE N’EST PAS UN PARAMÈTRE — il vient du contexte serveur', async () => {
    // Le point qui rend le prêt sûr. Le modèle ne peut pas désigner où va le fichier : la cible
    // est le fil d'où vient la demande, lu dans le `requestContext`, que le modèle ne voit pas.
    const digests = spyDelivery();
    const tool = build({ digests });

    await tool.execute!(
      { channelId: CHANNEL, asDocument: true, deliverTo: 'attaquant@exemple.com' } as never,
      ctx({ slackChannel: 'C0THREAD', slackThreadTs: '1700000000.000100' }) as never,
    );

    expect(digests.deliver).toHaveBeenCalledWith(expect.objectContaining({ channelId: CHANNEL }), {
      channel: 'C0THREAD',
      threadTs: '1700000000.000100',
    });
    expect(JSON.stringify(digests.deliver.mock.calls)).not.toContain('attaquant');
  });

  it('HORS SLACK, l’outil refuse AVANT même la question du fichier', async () => {
    // ⚠️ La garantie est plus forte que celle que ce test cherchait d'abord. Sans canal,
    // `readSlackContext` rend `undefined` en entier — il n'y a donc ni demandeur ni cible, et
    // l'outil s'arrête à `no_requester`. Le prêt n'a pas besoin d'une garde propre : il vit
    // derrière une frontière qui a déjà refusé.
    const digests = spyDelivery();
    const tool = build({ digests });

    const result = (await tool.execute!(
      { channelId: CHANNEL, asDocument: true },
      ctx({ slackChannel: undefined }) as never,
    )) as Record<string, unknown>;

    expect(digests.deliver).not.toHaveBeenCalled();
    expect(result.found).toBe(false);
    expect(result.reason).toBe('no_requester');
  });
});

describe('le prêt dégrade, il n’est jamais un point de panne', () => {
  it('sans dépendance câblée, le texte part quand même', async () => {
    const tool = build();

    const result = (await tool.execute!(
      { channelId: CHANNEL, asDocument: true },
      ctx() as never,
    )) as Record<string, unknown>;

    expect(result.found).toBe(true);
    expect(result.document).toBe('unavailable');
  });

  it('une livraison en échec est DITE, jamais tue', async () => {
    // Même règle que `generateDocument` : on ne prétend jamais avoir livré. Le modèle doit
    // pouvoir dire « le résumé est là, le fichier n'a pas pu partir ».
    const deliver = vi.fn(async () => ({
      delivered: false as const,
      reason: 'post_failed' as const,
    }));
    const tool = build({ digests: { deliver } });

    const result = (await tool.execute!(
      { channelId: CHANNEL, asDocument: true },
      ctx() as never,
    )) as Record<string, unknown>;

    expect(result.found).toBe(true);
    expect(result.document).toBe('failed');
  });

  it('une livraison qui LÈVE ne casse pas la réponse', async () => {
    const deliver = vi.fn(async () => {
      throw new Error('slack down');
    });
    const tool = build({ digests: { deliver } });

    const result = (await tool.execute!(
      { channelId: CHANNEL, asDocument: true },
      ctx() as never,
    )) as Record<string, unknown>;

    expect(result.found).toBe(true);
    expect(result.document).toBe('failed');
  });
});

describe('le prêt est déclaré au registre', () => {
  it('`channelDigest` y figure, exécuté par cet outil', () => {
    const loan = CAPABILITY_LOANS.find((l) => l.name === 'channelDigest');
    expect(loan).toBeDefined();
    expect(loan?.extendsTool).toBe('getChannelHistory');
    expect(loan?.deliversTo).toBe('requester');
  });
});

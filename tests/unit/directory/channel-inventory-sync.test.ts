import { describe, it, expect, vi } from 'vitest';

import {
  makeChannelCoverage,
  type ChannelAccessSource,
  type ChannelMemberScan,
  type ChannelSnapshot,
} from '../../../src/features/directory/application/services/channel-coverage.service';
import { InMemoryChannelInventoryRepository } from '../../../src/features/directory/infrastructure/repositories/in-memory-channel.repository';
import {
  MEMBER_SCAN_CAP,
  SlackChannelAccess,
  type SlackChannelReader,
} from '../../../src/features/directory/infrastructure/providers/slack-channel-access.adapter';

/**
 * La passe d'INVENTAIRE de la couverture de canaux : ce que le bot observe est enregistré.
 *
 * ⚠️ Rappel qui gouverne tout ce fichier : cet inventaire est de l'OBSERVABILITÉ, jamais de
 * l'autorisation. Aucun événement Slack ne l'invalide (`member_joined_channel` /
 * `member_left_channel` ne sont pas abonnés). Le garde-fou structurel correspondant vit dans
 * `channel-inventory-not-an-acl.test.ts`.
 *
 * Quatre propriétés sont verrouillées ici :
 *   • l'inventaire est OPTIONNEL — sans repository, pas une écriture ni un appel de plus, ce qui
 *     est la condition pour laisser ce service câblé au boot d'une fonction Vercel ;
 *   • `is_member` enregistré est celui d'APRÈS l'adhésion, pas l'instantané du balayage ;
 *   • on n'énumère QUE les canaux accessibles — `conversations.members` répond
 *     `channel_not_found` sur un privé dont le bot est absent, et un rapport durablement
 *     « dégradé » pour un état normal ne signale plus rien ;
 *   • l'échec d'un canal ne coule pas la passe.
 */

/** Les canaux RÉELS du workspace Kisso, relevés le 2026-08-12. */
function kissoChannels(): ChannelSnapshot[] {
  return [
    {
      id: 'CMLKC4S5T',
      name: 'kisso-hq',
      isPrivate: false,
      isArchived: false,
      isMember: true,
      memberCountReported: 6,
    },
    {
      id: 'C0BJGBVB5HP',
      name: 'engineer-karyl',
      isPrivate: true,
      isArchived: false,
      isMember: true,
      memberCountReported: null,
    },
    {
      id: 'CMA1TPCN6',
      name: 'alerts-dev',
      isPrivate: false,
      isArchived: false,
      isMember: false,
      memberCountReported: 4,
    },
    {
      id: 'CPRIVEE',
      name: 'direction',
      isPrivate: true,
      isArchived: false,
      isMember: false,
      memberCountReported: null,
    },
  ];
}

const MEMBERS: Record<string, string[]> = {
  CMLKC4S5T: ['U1', 'U2', 'U3', 'U4', 'U5', 'U6'],
  C0BJGBVB5HP: ['U1', 'U2', 'U3', 'U4'],
  CMA1TPCN6: ['U1', 'U2', 'U3', 'U4'],
};

function makeSource(
  channels: ChannelSnapshot[] = kissoChannels(),
  overrides: Partial<ChannelAccessSource> = {},
): ChannelAccessSource {
  return {
    listChannels: vi.fn(async () => ({ channels, truncated: false })),
    join: vi.fn(async () => ({ status: 'joined' as const })),
    listMembers: vi.fn(async (id: string): Promise<ChannelMemberScan> => ({
      memberIds: MEMBERS[id] ?? [],
      truncated: false,
    })),
    ...overrides,
  };
}

const T0 = new Date('2026-08-12T09:00:00.000Z');
const T1 = new Date('2026-08-13T09:00:00.000Z');

describe('Directory: inventaire des canaux', () => {
  it('enregistre TOUS les canaux vus, membres ou non', async () => {
    const inventory = new InMemoryChannelInventoryRepository();

    const report = await makeChannelCoverage({
      source: makeSource(),
      inventory,
      now: () => T0,
    }).run();

    expect(report.inventory?.channelsRecorded).toBe(4);
    expect((await inventory.listChannels()).map((c) => c.channelId)).toEqual([
      'C0BJGBVB5HP',
      'CMA1TPCN6',
      'CMLKC4S5T',
      'CPRIVEE',
    ]);
  });

  it("enregistre l'`isMember` d'APRÈS la passe d'adhésion, pas l'instantané du balayage", async () => {
    // `#alerts-dev` est vu `isMember: false` puis REJOINT. Recopier l'instantané écrirait
    // `is_member = 0` sur un canal où `chat.postMessage` fonctionne désormais — et c'est le seul
    // champ dont ce booléen décide.
    const inventory = new InMemoryChannelInventoryRepository();

    await makeChannelCoverage({ source: makeSource(), inventory, now: () => T0 }).run();

    const channels = await inventory.listChannels();
    expect(channels.find((c) => c.channelId === 'CMA1TPCN6')?.isMember).toBe(true);
    // Le canal privé où le bot n'est pas — et ne peut pas entrer — reste non membre.
    expect(channels.find((c) => c.channelId === 'CPRIVEE')?.isMember).toBe(false);
  });

  it("n'énumère les membres QUE des canaux accessibles", async () => {
    // `conversations.members` répond `channel_not_found` sur un privé dont le bot est absent :
    // appeler quand même fabriquerait un échec permanent pour un état parfaitement normal.
    const source = makeSource();
    const inventory = new InMemoryChannelInventoryRepository();

    const report = await makeChannelCoverage({ source, inventory, now: () => T0 }).run();

    const called = (source.listMembers as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(called.sort()).toEqual(['C0BJGBVB5HP', 'CMA1TPCN6', 'CMLKC4S5T']);
    expect(called).not.toContain('CPRIVEE');
    expect(report.inventory?.channelsWithMembers).toBe(3);
    expect(report.inventory?.membersRecorded).toBe(14);
  });

  it('rend le compte OBSERVÉ à côté de l’assertion de Slack, sans les fondre', async () => {
    const inventory = new InMemoryChannelInventoryRepository();

    await makeChannelCoverage({ source: makeSource(), inventory, now: () => T0 }).run();

    const entries = await inventory.listInventory();
    const hq = entries.find((e) => e.channel.channelId === 'CMLKC4S5T');
    expect(hq?.observedMemberCount).toBe(6);
    expect(hq?.channel.memberCountReported).toBe(6);

    // Le canal privé : Slack n'affirme rien, mais le compte observé, lui, existe.
    const prive = entries.find((e) => e.channel.channelId === 'C0BJGBVB5HP');
    expect(prive?.observedMemberCount).toBe(4);
    expect(prive?.channel.memberCountReported).toBeNull();
  });

  it('REMPLACE les membres d’une passe à l’autre en conservant `firstSeenAt`', async () => {
    const inventory = new InMemoryChannelInventoryRepository();
    const channels = [kissoChannels()[0]];

    await makeChannelCoverage({
      source: makeSource(channels),
      inventory,
      now: () => T0,
    }).run();

    // Deuxième passe : U6 est parti, U7 est arrivé.
    const partis = makeSource(channels, {
      listMembers: vi.fn(async () => ({
        memberIds: ['U1', 'U2', 'U3', 'U4', 'U5', 'U7'],
        truncated: false,
      })),
    });
    await makeChannelCoverage({ source: partis, inventory, now: () => T1 }).run();

    const members = await inventory.listObservedMembers('CMLKC4S5T');
    expect(members.map((m) => m.slackUserId)).toEqual(['U1', 'U2', 'U3', 'U4', 'U5', 'U7']);
    expect(members.find((m) => m.slackUserId === 'U1')?.firstSeenAt.getTime()).toBe(T0.getTime());
    expect(members.find((m) => m.slackUserId === 'U7')?.firstSeenAt.getTime()).toBe(T1.getTime());
  });

  it("l'échec d'un canal ne coule pas la passe — il est nommé et le verdict dégrade", async () => {
    const inventory = new InMemoryChannelInventoryRepository();
    vi.spyOn(inventory, 'replaceMembers').mockImplementation(async (channelId) => {
      if (channelId === 'CMLKC4S5T') throw new Error('SQLITE_ERROR: no such table: slack_channels');
    });

    const report = await makeChannelCoverage({
      source: makeSource(),
      inventory,
      now: () => T0,
    }).run();

    expect(report.outcome).toBe('degraded');
    expect(report.inventory?.failures).toEqual([
      {
        channelId: 'CMLKC4S5T',
        name: 'kisso-hq',
        error: 'SQLITE_ERROR: no such table: slack_channels',
      },
    ]);
    // Les autres canaux ont bien été traités : un `throw` aurait tout perdu.
    expect(report.inventory?.channelsWithMembers).toBe(2);
  });

  it('un balayage de membres TRONQUÉ dégrade le verdict et nomme le canal', async () => {
    // Un plafond silencieux se lit « tout est synchronisé ».
    const inventory = new InMemoryChannelInventoryRepository();
    const source = makeSource(undefined, {
      listMembers: vi.fn(async (id: string) => ({
        memberIds: MEMBERS[id] ?? [],
        truncated: id === 'CMLKC4S5T',
      })),
    });

    const report = await makeChannelCoverage({ source, inventory, now: () => T0 }).run();

    expect(report.outcome).toBe('degraded');
    expect(report.inventory?.truncatedChannels).toEqual(['CMLKC4S5T']);
  });

  it("SANS repository : aucune écriture, aucun appel `listMembers`, aucun rapport d'inventaire", async () => {
    // C'est ce qui permet de laisser `makeChannelCoverage` câblé dans `src/mastra/index.ts`,
    // donc atteignable au boot d'une fonction Vercel — le chemin des 3 s d'ACK de Slack.
    const source = makeSource();

    const report = await makeChannelCoverage({ source }).run();

    expect(report.inventory).toBeUndefined();
    expect(source.listMembers).not.toHaveBeenCalled();
    expect(report.outcome).toBe('completed');
  });

  it("SANS `listMembers` sur la source : pas d'inventaire du tout, plutôt qu'un inventaire à zéro", async () => {
    // « Non demandé » et « demandé, rien trouvé » ne doivent pas se ressembler.
    const inventory = new InMemoryChannelInventoryRepository();
    const source: ChannelAccessSource = {
      listChannels: vi.fn(async () => ({ channels: kissoChannels(), truncated: false })),
      join: vi.fn(async () => ({ status: 'joined' as const })),
    };

    const report = await makeChannelCoverage({ source, inventory, now: () => T0 }).run();

    expect(report.inventory).toBeUndefined();
    expect(await inventory.listChannels()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// L'adaptateur Slack — la borne du balayage des membres
// ─────────────────────────────────────────────────────────────────────────────

function makeReader(overrides: Partial<SlackChannelReader> = {}): SlackChannelReader {
  return {
    listChannelMembershipsPage: vi.fn(async () => ({ channels: [] })),
    joinChannel: vi.fn(async () => ({ status: 'joined' as const })),
    listChannels: vi.fn(async () => []),
    getChannelMembers: vi.fn(async () => []),
    ...overrides,
  };
}

describe('Directory: adaptateur Slack — balayage des membres', () => {
  it('rend les membres observés, sans identifiant vide', async () => {
    const reader = makeReader({
      getChannelMembers: vi.fn(async () => ['U1', '', 'U2']),
    });

    const scan = await new SlackChannelAccess(reader).listMembers('CMLKC4S5T');

    // Un identifiant vide ne désigne personne et gonflerait le `COUNT(*)`, c'est-à-dire le seul
    // chiffre que cet inventaire existe pour rendre.
    expect(scan).toEqual({ memberIds: ['U1', 'U2'], truncated: false });
  });

  it('BORNE le balayage et le signale — un plafond muet se lit « tout est synchronisé »', async () => {
    // `SlackWorkspaceService.getChannelMembers` déroule `conversations.members` avec un
    // `while (cursor)` NU, sans plafond de pages, contrairement à toutes les autres boucles du
    // fournisseur. La borne est donc appliquée ICI, et elle est DÉRIVÉE des constantes déjà en
    // place (`SLACK_MAX_PAGES × SLACK_PAGE_LIMIT`), jamais saisie à la main.
    const trop = Array.from({ length: MEMBER_SCAN_CAP + 10 }, (_, i) => `U${i}`);
    const reader = makeReader({ getChannelMembers: vi.fn(async () => trop) });

    const scan = await new SlackChannelAccess(reader).listMembers('CMLKC4S5T');

    expect(scan.truncated).toBe(true);
    expect(scan.memberIds).toHaveLength(MEMBER_SCAN_CAP);
  });

  it("ne demande PAS `num_members` par défaut : c'est un second balayage complet", async () => {
    const reader = makeReader({
      listChannelMembershipsPage: vi.fn(async () => ({
        channels: [
          {
            id: 'CMLKC4S5T',
            name: 'kisso-hq',
            isPrivate: false,
            isArchived: false,
            isMember: true,
          },
        ],
      })),
    });

    const { channels } = await new SlackChannelAccess(reader).listChannels();

    expect(reader.listChannels).not.toHaveBeenCalled();
    // ABSENT, et non `null` : la source ne porte pas l'assertion, elle n'affirme pas qu'il n'y
    // en a pas. Le consommateur retombe sur `null`.
    expect(channels[0].memberCountReported).toBeUndefined();
  });

  it('retraduit le `0` de `num_members` en `null` quand il est demandé', async () => {
    // `SlackWorkspaceService.listChannels()` projette `ch.num_members ?? 0` : l'absence du champ
    // — fréquente sur les canaux privés — y devient indiscernable d'un canal vide. Enregistrer ce
    // `0` produirait un écart permanent et FAUX avec le compte observé, et un signal de fraîcheur
    // qui crie en permanence ne signale plus rien.
    const reader = makeReader({
      listChannelMembershipsPage: vi.fn(async () => ({
        channels: [
          {
            id: 'CMLKC4S5T',
            name: 'kisso-hq',
            isPrivate: false,
            isArchived: false,
            isMember: true,
          },
          {
            id: 'C0BJGBVB5HP',
            name: 'engineer-karyl',
            isPrivate: true,
            isArchived: false,
            isMember: true,
          },
        ],
      })),
      listChannels: vi.fn(async () => [
        { id: 'CMLKC4S5T', memberCount: 6 },
        { id: 'C0BJGBVB5HP', memberCount: 0 },
      ]),
    });

    const { channels } = await new SlackChannelAccess(reader, {
      reportedMemberCounts: true,
    }).listChannels();

    expect(channels.find((c) => c.id === 'CMLKC4S5T')?.memberCountReported).toBe(6);
    expect(channels.find((c) => c.id === 'C0BJGBVB5HP')?.memberCountReported).toBeUndefined();
  });

  it("n'échoue pas quand `num_members` est inaccessible — le compte observé fait foi", async () => {
    const reader = makeReader({
      listChannelMembershipsPage: vi.fn(async () => ({
        channels: [
          {
            id: 'CMLKC4S5T',
            name: 'kisso-hq',
            isPrivate: false,
            isArchived: false,
            isMember: true,
          },
        ],
      })),
      listChannels: vi.fn(async () => {
        throw new Error('An API error occurred: missing_scope');
      }),
    });

    const { channels } = await new SlackChannelAccess(reader, {
      reportedMemberCounts: true,
    }).listChannels();

    expect(channels[0].memberCountReported).toBeUndefined();
  });
});

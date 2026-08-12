import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';

import * as schema from '../../../src/infrastructure/database/schema';
import { slackChannelMembers, slackChannels } from '../../../src/infrastructure/database/schema';
import { DrizzleChannelInventoryRepository } from '../../../src/features/directory/infrastructure/repositories/drizzle-channel.repository';
import { InMemoryChannelInventoryRepository } from '../../../src/features/directory/infrastructure/repositories/in-memory-channel.repository';
import type { SlackChannelFacts } from '../../../src/features/directory/domain/entities/slack-channel';
import type { ChannelInventoryRepository } from '../../../src/features/directory/domain/ports/channel.repository';

/**
 * Le contrat de l'inventaire des canaux, verrouillé sur les DEUX implémentations par la MÊME
 * suite — comme pour `DirectoryRepository`.
 *
 * Deux propriétés justifient ce fichier, et elles tirent en sens opposés :
 *
 *  1. `replaceMembers` REMPLACE. Les membres d'un canal à l'instant T sont un ENSEMBLE, pas une
 *     accumulation : une personne partie doit DISPARAÎTRE, sinon le `COUNT(*)` — le seul chiffre
 *     que cette table existe pour rendre — devient un cumul historique.
 *  2. `first_seen_at` SURVIT pour une personne toujours présente. C'est la seule donnée que cet
 *     inventaire accumule et que Slack ne sait pas rendre ; la réécrire à chaque passage serait
 *     une perte muette, dans la lignée exacte de `documents.content`.
 *
 * L'implémentation Drizzle est exercée contre une VRAIE base libsql en mémoire : « la colonne
 * n'a pas bougé » ne se démontre que contre du vrai SQL, puisque c'est le `set` de
 * l'`ON CONFLICT DO UPDATE` qui est en cause — un objet qu'aucun mock n'inspecterait.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Base libsql en mémoire, dont le DDL est DÉRIVÉ de `schema.ts`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * DDL reconstruit depuis la définition Drizzle, jamais recopié : une table de test écrite à la
 * main se désynchronise au premier changement de schéma, et c'est exactement l'écart qui a fait
 * perdre `documents.content` en production.
 *
 * Gère la PK COMPOSITE de `slack_channel_members` — `column.primary` est faux sur chacune de ses
 * colonnes, la contrainte vivant dans `config.primaryKeys`.
 *
 * La clé étrangère `channel_id → slack_channels(channel_id)` n'est volontairement pas émise :
 * chaque table se teste seule, et l'ordre d'écriture qui la satisfait est vérifié là où il est
 * décidé — dans la passe d'inventaire du service de couverture.
 */
function createTableSql(table: SQLiteTable): string {
  const config = getTableConfig(table);

  const parts = config.columns.map((column) => {
    const bits = [`"${column.name}"`, column.getSQLType()];
    if (column.primary) bits.push('PRIMARY KEY');
    else if (column.notNull) bits.push('NOT NULL');
    return bits.join(' ');
  });

  for (const pk of config.primaryKeys) {
    parts.push(`PRIMARY KEY (${pk.columns.map((c) => `"${c.name}"`).join(', ')})`);
  }

  return `CREATE TABLE "${config.name}" (${parts.join(', ')})`;
}

let client: Client | null = null;

async function makeDrizzleRepo(): Promise<ChannelInventoryRepository> {
  client = createClient({ url: ':memory:' });
  await client.execute(createTableSql(slackChannels));
  await client.execute(createTableSql(slackChannelMembers));
  const db = drizzle(client, { schema });
  return new DrizzleChannelInventoryRepository(() => db);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — les canaux RÉELS du workspace Kisso, relevés le 2026-08-12
// ─────────────────────────────────────────────────────────────────────────────

function canal(overrides: Partial<SlackChannelFacts> = {}): SlackChannelFacts {
  return {
    channelId: 'CMLKC4S5T',
    name: 'kisso-hq',
    isPrivate: false,
    isArchived: false,
    isMember: true,
    memberCountReported: 6,
    ...overrides,
  };
}

const T0 = new Date('2026-08-01T09:00:00.000Z');
const T1 = new Date('2026-08-12T09:00:00.000Z');

const implementations: Array<{ nom: string; make: () => Promise<ChannelInventoryRepository> }> = [
  { nom: 'DrizzleChannelInventoryRepository', make: makeDrizzleRepo },
  {
    nom: 'InMemoryChannelInventoryRepository',
    make: async () => new InMemoryChannelInventoryRepository(),
  },
];

describe.each(implementations)('$nom — contrat ChannelInventoryRepository', ({ make }) => {
  let repo: ChannelInventoryRepository;

  beforeEach(async () => {
    repo = await make();
  });

  afterEach(() => {
    client?.close();
    client = null;
  });

  // ── Canaux ─────────────────────────────────────────────────────────────────

  it('enregistre un canal et le rend par son identifiant', async () => {
    await repo.upsertChannel(canal(), T0);

    const [channel] = await repo.listChannels();
    expect(channel).toMatchObject({
      channelId: 'CMLKC4S5T',
      name: 'kisso-hq',
      isPrivate: false,
      isArchived: false,
      isMember: true,
      memberCountReported: 6,
    });
    expect(channel.syncedAt.getTime()).toBe(T0.getTime());
  });

  it('conserve `memberCountReported` à null quand Slack n’a rien affirmé', async () => {
    // Le canal privé : `conversations.list` ne rend pas toujours `num_members`. NULL dit
    // « Slack n'a rien affirmé » — un `0` serait indiscernable d'un canal vide, et produirait
    // un écart permanent et FAUX avec le compte observé.
    await repo.upsertChannel(
      canal({
        channelId: 'C0BJGBVB5HP',
        name: 'engineer-karyl',
        isPrivate: true,
        memberCountReported: null,
      }),
      T0,
    );

    const [channel] = await repo.listChannels();
    expect(channel.memberCountReported).toBeNull();
  });

  it('met à jour un canal renommé SANS le dupliquer — la clé est l’ID, pas le nom', async () => {
    await repo.upsertChannel(canal({ channelId: 'C09TRLL2KEW', name: 'random' }), T0);
    await repo.upsertChannel(canal({ channelId: 'C09TRLL2KEW', name: 'random-fr' }), T1);

    const channels = await repo.listChannels();
    expect(channels).toHaveLength(1);
    expect(channels[0].name).toBe('random-fr');
    expect(channels[0].syncedAt.getTime()).toBe(T1.getTime());
  });

  it('trie les canaux sur leur identifiant — deux appels rendent le même ordre', async () => {
    await repo.upsertChannel(canal({ channelId: 'CMLKC4S5T' }), T0);
    await repo.upsertChannel(canal({ channelId: 'C09TRLL2KEW' }), T0);
    await repo.upsertChannel(canal({ channelId: 'CMA1TPCN6' }), T0);

    const ids = (await repo.listChannels()).map((c) => c.channelId);
    expect(ids).toEqual(['C09TRLL2KEW', 'CMA1TPCN6', 'CMLKC4S5T']);
  });

  // ── Membres ────────────────────────────────────────────────────────────────

  it('enregistre les membres observés d’un canal', async () => {
    await repo.upsertChannel(canal(), T0);
    await repo.replaceMembers('CMLKC4S5T', ['U1', 'U2', 'U3', 'U4', 'U5', 'U6'], T0);

    const members = await repo.listObservedMembers('CMLKC4S5T');
    expect(members.map((m) => m.slackUserId)).toEqual(['U1', 'U2', 'U3', 'U4', 'U5', 'U6']);
    expect(members[0].firstSeenAt.getTime()).toBe(T0.getTime());
    expect(members[0].syncedAt.getTime()).toBe(T0.getTime());
  });

  it('REMPLACE au lieu de fusionner — une personne partie disparaît', async () => {
    // LA propriété du lot. Sans elle, `COUNT(*)` deviendrait un cumul historique et le nombre
    // de personnes dans le canal — la demande d'origine — ne serait jamais juste.
    await repo.upsertChannel(canal(), T0);
    await repo.replaceMembers('CMLKC4S5T', ['U1', 'U2', 'U3'], T0);

    await repo.replaceMembers('CMLKC4S5T', ['U1', 'U3'], T1);

    const members = await repo.listObservedMembers('CMLKC4S5T');
    expect(members.map((m) => m.slackUserId)).toEqual(['U1', 'U3']);
  });

  it('PRÉSERVE `firstSeenAt` d’une personne toujours présente', async () => {
    // Symétrique du contrat d'`upsertFacts` sur `dm_channel_id` : le champ que la
    // resynchronisation ne doit JAMAIS toucher. Une perte muette, sinon.
    await repo.upsertChannel(canal(), T0);
    await repo.replaceMembers('CMLKC4S5T', ['U1', 'U2'], T0);

    await repo.replaceMembers('CMLKC4S5T', ['U1', 'U2'], T1);

    const members = await repo.listObservedMembers('CMLKC4S5T');
    expect(members.map((m) => m.firstSeenAt.getTime())).toEqual([T0.getTime(), T0.getTime()]);
    // `syncedAt`, lui, avance : c'est la preuve que la personne a été REVUE.
    expect(members.map((m) => m.syncedAt.getTime())).toEqual([T1.getTime(), T1.getTime()]);
  });

  it('donne son propre `firstSeenAt` à une personne qui arrive', async () => {
    await repo.upsertChannel(canal(), T0);
    await repo.replaceMembers('CMLKC4S5T', ['U1'], T0);
    await repo.replaceMembers('CMLKC4S5T', ['U1', 'U2'], T1);

    const members = await repo.listObservedMembers('CMLKC4S5T');
    expect(members.find((m) => m.slackUserId === 'U1')?.firstSeenAt.getTime()).toBe(T0.getTime());
    expect(members.find((m) => m.slackUserId === 'U2')?.firstSeenAt.getTime()).toBe(T1.getTime());
  });

  it('accepte un ensemble VIDE — « plus personne d’observé » vide le canal', async () => {
    await repo.upsertChannel(canal(), T0);
    await repo.replaceMembers('CMLKC4S5T', ['U1', 'U2'], T0);

    await repo.replaceMembers('CMLKC4S5T', [], T1);

    expect(await repo.listObservedMembers('CMLKC4S5T')).toEqual([]);
  });

  it('ne touche QUE le canal visé — les autres gardent leurs membres', async () => {
    await repo.upsertChannel(canal({ channelId: 'CMLKC4S5T' }), T0);
    await repo.upsertChannel(canal({ channelId: 'CMA1TPCN6', name: 'alerts-dev' }), T0);
    await repo.replaceMembers('CMLKC4S5T', ['U1', 'U2'], T0);
    await repo.replaceMembers('CMA1TPCN6', ['U3', 'U4'], T0);

    await repo.replaceMembers('CMLKC4S5T', [], T1);

    expect(await repo.listObservedMembers('CMLKC4S5T')).toEqual([]);
    expect((await repo.listObservedMembers('CMA1TPCN6')).map((m) => m.slackUserId)).toEqual([
      'U3',
      'U4',
    ]);
  });

  it('dédoublonne un identifiant rendu deux fois par Slack', async () => {
    // `conversations.members` peut redire le même identifiant à cheval sur deux pages. Sans
    // dédoublonnage, l'INSERT multi-lignes lèverait « cannot affect row a second time » et
    // ferait échouer la passe entière pour une redite bénigne.
    await repo.upsertChannel(canal(), T0);
    await repo.replaceMembers('CMLKC4S5T', ['U1', 'U1', 'U2'], T0);

    const members = await repo.listObservedMembers('CMLKC4S5T');
    expect(members.map((m) => m.slackUserId)).toEqual(['U1', 'U2']);
  });

  // ── Inventaire : les deux comptes, jamais fondus ───────────────────────────

  it('rend le compte OBSERVÉ à côté de l’assertion de Slack, sans les confondre', async () => {
    // L'écart est l'information : deux appels distincts, deux instants distincts. Le fondre en
    // un seul chiffre supprimerait le seul signal de fraîcheur d'une table qu'aucun événement
    // Slack ne dément.
    await repo.upsertChannel(canal({ memberCountReported: 6 }), T0);
    await repo.replaceMembers('CMLKC4S5T', ['U1', 'U2', 'U3', 'U4'], T0);

    const [entry] = await repo.listInventory();
    expect(entry.observedMemberCount).toBe(4);
    expect(entry.channel.memberCountReported).toBe(6);
  });

  it('rapporte un canal SANS membre observé avec un compte de 0, jamais en l’omettant', async () => {
    // Un canal absent du rapport se lirait « pas de problème ». Un canal connu sans membre
    // observé est précisément ce qu'il faut voir.
    await repo.upsertChannel(canal({ channelId: 'CMA1TPCN6', name: 'alerts-dev' }), T0);

    const inventory = await repo.listInventory();
    expect(inventory).toHaveLength(1);
    expect(inventory[0].observedMemberCount).toBe(0);
  });

  it('répond à « dans quels canaux cette personne a-t-elle été observée ? »', async () => {
    await repo.upsertChannel(canal({ channelId: 'CMLKC4S5T' }), T0);
    await repo.upsertChannel(canal({ channelId: 'CMA1TPCN6' }), T0);
    await repo.upsertChannel(canal({ channelId: 'C09TRLL2KEW' }), T0);
    await repo.replaceMembers('CMLKC4S5T', ['U1', 'U2'], T0);
    await repo.replaceMembers('CMA1TPCN6', ['U2'], T0);
    await repo.replaceMembers('C09TRLL2KEW', ['U3'], T0);

    const observed = await repo.listChannelsObservedForUser('U2');
    expect(observed.map((m) => m.channelId)).toEqual(['CMA1TPCN6', 'CMLKC4S5T']);
    // Les dates d'observation voyagent avec : un appelant qui ne les voit pas ne peut pas
    // savoir qu'il lit un état ancien.
    expect(observed[0].syncedAt.getTime()).toBe(T0.getTime());
  });

  it('rend une liste vide pour une personne jamais observée — jamais une exception', async () => {
    expect(await repo.listChannelsObservedForUser('UINCONNU')).toEqual([]);
    expect(await repo.listObservedMembers('CINCONNU')).toEqual([]);
  });
});

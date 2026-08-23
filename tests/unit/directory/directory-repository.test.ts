import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { getTableConfig } from 'drizzle-orm/sqlite-core';

import * as schema from '../../../src/infrastructure/database/schema';
import { slackDirectory } from '../../../src/infrastructure/database/schema';
import { DrizzleDirectoryRepository } from '../../../src/features/directory/infrastructure/repositories/drizzle-directory.repository';
import { InMemoryDirectoryRepository } from '../../../src/features/directory/infrastructure/repositories/in-memory-directory.repository';
import type { DirectoryMemberFacts } from '../../../src/features/directory/domain/entities/directory-member';
import type { DirectoryRepository } from '../../../src/features/directory/domain/ports/directory.repository';

/**
 * Le contrat de l'annuaire, verrouillé sur les DEUX implémentations par la MÊME suite.
 *
 * La propriété qui justifie ce fichier tient en une phrase : `upsertFacts` ne doit JAMAIS
 * toucher `dm_channel_id`, `employee_id` ni `first_seen_at`. Une synchronisation complète
 * repasse sur toutes les lignes ; si elle réécrivait l'enregistrement entier, chaque passage
 * effacerait le canal de DM appris au fil des messages — que Slack ne sait PAS nous rendre
 * (`conversations.list({types:'im'})` répond `missing_scope`) — et le rattachement à l'employé.
 * Une perte muette, dans la lignée exacte de `documents.content`.
 *
 * L'implémentation Drizzle est exercée contre une VRAIE base libsql en mémoire : on ne mocke
 * jamais Drizzle à la main, et « la colonne n'a pas bougé » ne se démontre que contre du vrai
 * SQL — c'est le `set` de l'`ON CONFLICT DO UPDATE` qui est en cause, un objet qu'aucun mock
 * n'inspecterait.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Base libsql en mémoire, dont le DDL est DÉRIVÉ de `schema.ts`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Le DDL est reconstruit depuis la définition Drizzle, jamais recopié : une table de test écrite
 * à la main se désynchronise au premier changement de schéma, et c'est exactement ce genre
 * d'écart qui a fait perdre en silence `documents.content` en production.
 *
 * La clé étrangère `employee_id → employees.id` n'est volontairement pas émise : l'annuaire se
 * teste seul, et créer la table `employees` ici n'ajouterait aucune garantie sur ce contrat.
 */
function createTableSql(table: Parameters<typeof getTableConfig>[0]): string {
  const config = getTableConfig(table);

  const columns = config.columns.map((column) => {
    const parts = [`"${column.name}"`, column.getSQLType()];
    if (column.primary) parts.push('PRIMARY KEY');
    else if (column.notNull) parts.push('NOT NULL');
    return parts.join(' ');
  });

  return `CREATE TABLE "${config.name}" (${columns.join(', ')})`;
}

let client: Client | null = null;

async function makeDrizzleRepo(): Promise<DirectoryRepository> {
  client = createClient({ url: ':memory:' });
  await client.execute(createTableSql(slackDirectory));
  const db = drizzle(client, { schema });
  return new DrizzleDirectoryRepository(() => db);
}

/** Lecture BRUTE, hors du port : c'est la seule façon de voir ce que l'upsert a écrit. */
async function rawRow(slackUserId: string) {
  const result = await client!.execute({
    sql: 'SELECT dm_channel_id, employee_id, first_seen_at, synced_at, real_name FROM slack_directory WHERE slack_user_id = ?',
    args: [slackUserId],
  });
  return result.rows[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function faits(overrides: Partial<DirectoryMemberFacts> = {}): DirectoryMemberFacts {
  return {
    slackUserId: 'U0AWA',
    teamId: 'TMLKC4EPP',
    email: 'awa.diop@kissohq.com',
    realName: 'Awa Diop',
    displayName: 'awa',
    firstName: null,
    lastName: null,
    title: null,
    isBot: false,
    isAdmin: false,
    isRestricted: false,
    isUltraRestricted: false,
    isDeleted: false,
    ...overrides,
  };
}

const T0 = new Date('2026-08-01T09:00:00.000Z');
const T1 = new Date('2026-08-12T09:00:00.000Z');

// ─────────────────────────────────────────────────────────────────────────────
// Contrat commun aux deux implémentations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pose le rôle `manager` — DÉLIBÉRÉMENT hors du port.
 *
 * `DirectoryRepository` ne déclare AUCUNE écriture du rôle, parce qu'il n'en existe aucune dans
 * le produit : la colonne se pose par `npm run role:set`, hors de portée de tout chemin exposé
 * à un agent. La déclarer dans le port en ferait une capacité que n'importe quel câblage futur
 * pourrait brancher sans la relire — la situation exacte de `discoverSlackWorkspace` avant sa
 * suppression.
 *
 * Ce helper branche donc sur l'implémentation, et c'est le reflet fidèle de cette asymétrie :
 * en base, un `UPDATE` ; dans la doublure, un utilitaire de test.
 */
async function setManager(repo: DirectoryRepository, slackUserId: string): Promise<void> {
  const doublure = repo as Partial<InMemoryDirectoryRepository>;
  if (typeof doublure.setRole === 'function') {
    doublure.setRole(slackUserId, true);
    return;
  }

  await client!.execute({
    sql: 'UPDATE slack_directory SET role = ? WHERE slack_user_id = ?',
    args: ['manager', slackUserId],
  });
}

const implementations: Array<{ nom: string; make: () => Promise<DirectoryRepository> }> = [
  { nom: 'DrizzleDirectoryRepository', make: makeDrizzleRepo },
  { nom: 'InMemoryDirectoryRepository', make: async () => new InMemoryDirectoryRepository() },
];

describe.each(implementations)('$nom — contrat DirectoryRepository', ({ make }) => {
  let repo: DirectoryRepository;

  beforeEach(async () => {
    repo = await make();
  });

  afterEach(() => {
    client?.close();
    client = null;
  });

  // ── Lecture ────────────────────────────────────────────────────────────────

  it('enregistre une personne et la rend par son identifiant Slack', async () => {
    await repo.upsertFacts(faits(), T0);

    const membre = await repo.findBySlackUserId('U0AWA');

    expect(membre).not.toBeNull();
    expect(membre!.email).toBe('awa.diop@kissohq.com');
    expect(membre!.realName).toBe('Awa Diop');
    expect(membre!.isRestricted).toBe(false);
    // Les faits que Slack ignore partent à leur valeur neutre.
    expect(membre!.dmChannelId).toBeNull();
    expect(membre!.employeeId).toBeNull();
    expect(membre!.firstSeenAt.getTime()).toBe(T0.getTime());
    expect(membre!.syncedAt.getTime()).toBe(T0.getTime());
  });

  it('rend null sur un identifiant Slack inconnu', async () => {
    expect(await repo.findBySlackUserId('U0INCONNU')).toBeNull();
  });

  it('retrouve une personne par son email — la question que trois agents posaient', async () => {
    await repo.upsertFacts(faits(), T0);

    const membre = await repo.findByEmail('awa.diop@kissohq.com');

    expect(membre?.slackUserId).toBe('U0AWA');
  });

  it('retrouve par email quelle que soit la casse, et sans les espaces du copier-coller', async () => {
    await repo.upsertFacts(faits(), T0);

    expect((await repo.findByEmail('  Awa.Diop@KissoHQ.com '))?.slackUserId).toBe('U0AWA');
  });

  it('rend null sur un email inconnu, vide, ou sur un compte sans adresse', async () => {
    await repo.upsertFacts(faits({ slackUserId: 'U0BOT', email: null, isBot: true }), T0);

    expect(await repo.findByEmail('personne@kissohq.com')).toBeNull();
    expect(await repo.findByEmail('')).toBeNull();
    expect(await repo.findByEmail('   ')).toBeNull();
  });

  // ── LE POINT CRITIQUE ──────────────────────────────────────────────────────

  it("n'écrase NI le canal de DM, NI l'employé, NI la date de première vue lors d'une resynchronisation", async () => {
    await repo.upsertFacts(faits(), T0);
    await repo.rememberDmChannel('U0AWA', 'D0AWA');
    await repo.linkEmployee('U0AWA', 'emp-42');

    // La synchronisation complète repasse sur la ligne avec des faits FRAIS et une date FRAÎCHE.
    await repo.upsertFacts(faits({ realName: 'Awa Diop Ndiaye', isAdmin: true }), T1);

    const membre = await repo.findBySlackUserId('U0AWA');
    expect(membre!.dmChannelId).toBe('D0AWA');
    expect(membre!.employeeId).toBe('emp-42');
    expect(membre!.firstSeenAt.getTime()).toBe(T0.getTime());
  });

  it('NI LE RÔLE — une resynchronisation ne rétrograde jamais le manager', async () => {
    // ⚠️ Le plus coûteux des quatre, et le seul qui touche à un DROIT. Slack ne connaît pas ce
    // fait : s'il figurait dans `DirectoryMemberFacts`, chaque synchronisation le remettrait à
    // sa valeur par défaut et le manager perdrait sa portée — en silence, sans erreur, et sans
    // que personne ne relie la panne (« le bot ne me laisse plus rien faire ») au script qu'on
    // a lancé la veille. C'est la famille exacte de `documents.content`.
    await repo.upsertFacts(faits(), T0);
    await setManager(repo, 'U0AWA');

    await repo.upsertFacts(faits({ realName: 'Awa Diop Ndiaye' }), T1);

    expect((await repo.findBySlackUserId('U0AWA'))!.isManager).toBe(true);
  });

  it('un manager DÉSACTIVÉ ne compte pas comme manager', async () => {
    // `hasManager()` autorise l'application de toute la frontière. S'il comptait un compte que
    // la politique refuse par ailleurs (`deactivated_account`), il ouvrirait l'application au
    // nom de quelqu'un qui n'a plus aucun droit — et rétrograderait tout le monde en croyant
    // l'inverse.
    await repo.upsertFacts(faits(), T0);
    await setManager(repo, 'U0AWA');
    expect(await repo.hasManager()).toBe(true);

    await repo.upsertFacts(faits({ isDeleted: true }), T1);
    expect(await repo.hasManager()).toBe(false);
  });

  it('un BOT porteur du rôle ne compte pas non plus', async () => {
    await repo.upsertFacts(faits(), T0);
    await setManager(repo, 'U0AWA');

    await repo.upsertFacts(faits({ isBot: true }), T1);
    expect(await repo.hasManager()).toBe(false);
  });

  it('rend `false` quand personne ne porte le rôle — l’état de DÉPART', async () => {
    // La colonne naît vide : « aucun manager » n'est pas un accident, c'est le premier état du
    // système. La garde qui refuse d'appliquer dans ce cas s'appuie sur ce contrat.
    await repo.upsertFacts(faits(), T0);
    expect(await repo.hasManager()).toBe(false);
  });

  it('met bien à jour les faits que Slack maintient, et la date de synchronisation', async () => {
    await repo.upsertFacts(faits(), T0);

    await repo.upsertFacts(
      faits({
        email: 'awa.ndiaye@kissohq.com',
        realName: 'Awa Diop Ndiaye',
        displayName: 'awa.n',
        isRestricted: true,
        isDeleted: true,
        teamId: 'TAUTRE',
      }),
      T1,
    );

    const membre = await repo.findBySlackUserId('U0AWA');
    expect(membre!.email).toBe('awa.ndiaye@kissohq.com');
    expect(membre!.realName).toBe('Awa Diop Ndiaye');
    expect(membre!.displayName).toBe('awa.n');
    expect(membre!.isRestricted).toBe(true);
    expect(membre!.isDeleted).toBe(true);
    expect(membre!.teamId).toBe('TAUTRE');
    expect(membre!.syncedAt.getTime()).toBe(T1.getTime());
  });

  // ── rememberDmChannel ──────────────────────────────────────────────────────

  it('mémorise le canal de DM au premier message direct', async () => {
    await repo.upsertFacts(faits(), T0);

    await repo.rememberDmChannel('U0AWA', 'D0AWA');

    expect((await repo.findBySlackUserId('U0AWA'))!.dmChannelId).toBe('D0AWA');
  });

  it('ne REMPLACE jamais un canal de DM déjà connu', async () => {
    await repo.upsertFacts(faits(), T0);
    await repo.rememberDmChannel('U0AWA', 'D0AWA');

    await repo.rememberDmChannel('U0AWA', 'D0AUTRE');

    expect((await repo.findBySlackUserId('U0AWA'))!.dmChannelId).toBe('D0AWA');
  });

  it('est sans effet — et sans erreur — sur une personne absente de l’annuaire', async () => {
    // La ligne naît de `upsertFacts`, jamais d'un identifiant de canal seul : un membre
    // fabriqué ici n'aurait ni email ni flags, donc un sujet d'autorisation entièrement par
    // défaut. On ne lève pas non plus — le DM est traité, l'annuaire rattrapera à la sync.
    await expect(repo.rememberDmChannel('U0INCONNU', 'D0X')).resolves.toBeUndefined();
    expect(await repo.findBySlackUserId('U0INCONNU')).toBeNull();
  });

  // ── linkEmployee ───────────────────────────────────────────────────────────

  it('rattache une personne à un employé, puis la détache avec null', async () => {
    await repo.upsertFacts(faits(), T0);

    await repo.linkEmployee('U0AWA', 'emp-42');
    expect((await repo.findBySlackUserId('U0AWA'))!.employeeId).toBe('emp-42');

    await repo.linkEmployee('U0AWA', null);
    expect((await repo.findBySlackUserId('U0AWA'))!.employeeId).toBeNull();
  });

  it('rattacher une personne absente ne lève pas, et REND 0', async () => {
    // ⚠️ Le compte est le contrat, pas un confort de journalisation — même argument que
    // `forget(scope)`. Trouvé EN PRODUCTION le 2026-08-19 : `linkEmployee` est un
    // `UPDATE … WHERE slack_user_id = ?`, donc sans ligne correspondante l'ordre RÉUSSIT sans
    // rien faire. L'appelant journalisait « Annuaire relié au dossier » dans ce cas — la
    // famille de défaut que ce correctif venait précisément fermer, reproduite par lui.
    //
    // Ce test tourne contre les DEUX implémentations : c'est ce qui garantit que la doublure
    // en mémoire ne rende pas 1 là où SQLite rend 0, écart qui rendrait les tests verts sur un
    // comportement que la production n'a pas.
    await expect(repo.linkEmployee('U0INCONNU', 'emp-42')).resolves.toBe(0);
  });

  it('rattacher une personne PRÉSENTE rend 1', async () => {
    await repo.upsertFacts(faits({ slackUserId: 'U0PRESENT' }), T0);

    await expect(repo.linkEmployee('U0PRESENT', 'emp-42')).resolves.toBe(1);
    expect((await repo.findBySlackUserId('U0PRESENT'))?.employeeId).toBe('emp-42');
  });

  // ── findAll ────────────────────────────────────────────────────────────────

  it('rend tout l’annuaire dans un ordre STABLE', async () => {
    await repo.upsertFacts(faits({ slackUserId: 'U0C' }), T0);
    await repo.upsertFacts(faits({ slackUserId: 'U0A' }), T0);
    await repo.upsertFacts(faits({ slackUserId: 'U0B' }), T0);

    // Sans ordre déclaré, deux appels identiques peuvent rendre deux ordres différents — défaut
    // déjà rencontré sur `getNotificationHistory`.
    expect((await repo.findAll()).map((m) => m.slackUserId)).toEqual(['U0A', 'U0B', 'U0C']);
    expect((await repo.findAll()).map((m) => m.slackUserId)).toEqual(['U0A', 'U0B', 'U0C']);
  });

  it('rend un tableau vide sur un annuaire vide', async () => {
    expect(await repo.findAll()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Propriétés qui ne se démontrent que contre du vrai SQL
// ─────────────────────────────────────────────────────────────────────────────

describe('DrizzleDirectoryRepository — ce que l’UPSERT écrit RÉELLEMENT', () => {
  let repo: DirectoryRepository;

  beforeEach(async () => {
    repo = await makeDrizzleRepo();
  });

  afterEach(() => {
    client?.close();
    client = null;
  });

  it('laisse dm_channel_id, employee_id et first_seen_at INTACTS en base', async () => {
    await repo.upsertFacts(faits(), T0);
    await repo.rememberDmChannel('U0AWA', 'D0AWA');
    await repo.linkEmployee('U0AWA', 'emp-42');

    await repo.upsertFacts(faits({ realName: 'Awa Diop Ndiaye' }), T1);

    // Lecture BRUTE : le port pourrait masquer une réécriture, la colonne non. C'est ici que se
    // vérifie que le `set` de l'`ON CONFLICT DO UPDATE` ne NOMME pas les colonnes protégées.
    const row = await rawRow('U0AWA');
    expect(row).not.toBeNull();
    expect(row!.dm_channel_id).toBe('D0AWA');
    expect(row!.employee_id).toBe('emp-42');
    expect(Number(row!.first_seen_at)).toBe(T0.getTime());
    expect(Number(row!.synced_at)).toBe(T1.getTime());
    expect(row!.real_name).toBe('Awa Diop Ndiaye');
  });

  it("n'insère pas de seconde ligne pour la même personne", async () => {
    await repo.upsertFacts(faits(), T0);
    await repo.upsertFacts(faits(), T1);
    await repo.upsertFacts(faits(), T1);

    const count = await client!.execute('SELECT COUNT(*) AS n FROM slack_directory');
    expect(Number(count.rows[0].n)).toBe(1);
  });

  it('préfère la correspondance EXACTE au repli insensible à la casse', async () => {
    await repo.upsertFacts(faits({ slackUserId: 'U0MAJ', email: 'Awa@kissohq.com' }), T0);
    await repo.upsertFacts(faits({ slackUserId: 'U0MIN', email: 'awa@kissohq.com' }), T0);

    expect((await repo.findByEmail('awa@kissohq.com'))?.slackUserId).toBe('U0MIN');
    expect((await repo.findByEmail('Awa@kissohq.com'))?.slackUserId).toBe('U0MAJ');
  });
});

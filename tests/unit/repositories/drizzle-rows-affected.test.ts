import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { getTableConfig } from 'drizzle-orm/sqlite-core';

import * as schema from '../../../src/infrastructure/database/schema';
import {
  slackEventDedup,
  pendingInterviewEmail,
} from '../../../src/infrastructure/database/schema';
import type { DatabaseInstance } from '../../../src/infrastructure/database/connection';
import { DrizzlePendingInterviewEmailRepository } from '../../../src/features/recruitment/infrastructure/repositories/drizzle-pending-email.repository';
import type { SlackEventDedupRepository } from '../../../src/features/notification/domain/ports/slack-event-dedup.repository';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * `rowsAffected` EST LE SEUL FAIT SUR LEQUEL REPOSENT LES DEUX PRISES DU PRODUIT
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Deux mécanismes de ce dépôt sont des PRISES : « j'ai le droit d'agir parce que c'est MOI qui
 * ai écrit la ligne, et le compte le prouve ».
 *
 *  • `DrizzleSlackEventDedupRepository.claim()` — la seule protection anti-double-réponse du
 *    produit. Défaut du 2026-08-11 : deux instances, deux réponses postées dans le même fil.
 *  • `DrizzlePendingInterviewEmailRepository.clear()` — ce qui empêche deux « oui » concurrents
 *    d'envoyer deux invitations au même candidat.
 *
 * Les deux lisent `rowsAffected` sur le résultat du pilote, et les deux le font à travers un
 * `?? 0`. Ce fichier existe parce que ce `?? 0` a une conséquence non évidente : si le champ
 * venait à DISPARAÎTRE du résultat (changement de pilote, enrobage, mise à jour de Drizzle), la
 * protection ne tomberait pas en panne bruyante — elle basculerait en ABANDON SILENCIEUX de
 * TOUT. Le bot serait muet, la file d'attente vide, et aucune erreur nulle part.
 *
 * ⚠️ Ces tests étaient IMPOSSIBLES à écrire jusqu'ici : `vitest.config.ts` exclut
 * `tests/unit/infrastructure/**` du run unitaire pour le rattacher à `test:integration`, que la
 * CI ne lance jamais. Dix dépôts Drizzle sont donc à 0 % de couverture. Ce fichier vit sous
 * `tests/unit/repositories/`, qui n'est PAS exclu — vérifié avant de le placer.
 *
 * ⚠️ AUCUNE base réelle n'est touchée : soit un libsql `:memory:`, soit une doublure de client.
 */

/** DDL dérivé du schéma Drizzle — même procédé que `tests/unit/recruitment/pending-email-repository.test.ts`. */
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

// ────────────────────────────────────────────────────────────────────────────
// La doublure de `getDb`. `DrizzleSlackEventDedupRepository` n'accepte AUCUN résolveur
// injecté — contrairement à son voisin `DrizzlePendingInterviewEmailRepository` — donc c'est
// le module de connexion lui-même qu'il faut doubler. Sans cela, le dépôt ouvrirait
// `data/kisso.db`, ce qui est précisément ce qu'un test unitaire ne doit jamais faire.
// ────────────────────────────────────────────────────────────────────────────
const holder = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('../../../src/infrastructure/database/connection', () => ({
  getDb: () => holder.db,
}));

const { DrizzleSlackEventDedupRepository } =
  await import('../../../src/features/notification/infrastructure/repositories/drizzle-slack-event-dedup.repository');

const GRACE_MS = 60_000;
const KEY = 'ts:D0KARYL:1755000000.000100';

let client: Client | null = null;

async function useRealMemoryDb(): Promise<void> {
  client = createClient({ url: ':memory:' });
  await client.execute(createTableSql(slackEventDedup));
  holder.db = drizzle(client, { schema });
}

afterEach(() => {
  client?.close();
  client = null;
  holder.db = null;
  vi.restoreAllMocks();
});

/**
 * Étage 1 — contre un VRAI pilote libsql.
 *
 * L'intérêt n'est pas de re-tester le contrat (la doublure in-memory le porte déjà, voir
 * `slack-event-dedup.repository.test.ts`) mais d'exécuter enfin le code Drizzle : jusqu'ici,
 * seule la FORME de son SQL était vérifiée, par lecture du fichier source.
 */
describe('DrizzleSlackEventDedupRepository — contre un vrai libsql en mémoire', () => {
  let repo: SlackEventDedupRepository;

  beforeEach(async () => {
    await useRealMemoryDb();
    repo = new DrizzleSlackEventDedupRepository();
  });

  it('accorde la première prise, refuse la seconde', async () => {
    await expect(repo.claim(KEY, { inFlightGraceMs: GRACE_MS })).resolves.toEqual({
      granted: true,
      reclaimed: false,
    });

    const second = await repo.claim(KEY, { inFlightGraceMs: GRACE_MS });
    expect(second.granted).toBe(false);
    expect(second).toMatchObject({ status: 'in-flight' });
    expect((second as { ageMs: number | null }).ageMs).not.toBeNull();
  });

  it('reprend une entrée abandonnée par la grâce, et le SIGNALE (`reclaimed: true`)', async () => {
    await repo.claim(KEY, { inFlightGraceMs: GRACE_MS });

    // Grâce nulle : l'entrée est déjà « trop vieille ». C'est le scénario de l'invocation tuée
    // en vol — sans reprise, l'événement serait perdu DÉFINITIVEMENT.
    await expect(repo.claim(KEY, { inFlightGraceMs: 0 })).resolves.toEqual({
      granted: true,
      reclaimed: true,
    });
  });

  it('refuse définitivement une clé `done`, même avec une grâce nulle', async () => {
    await repo.claim(KEY, { inFlightGraceMs: GRACE_MS });
    await repo.markDone(KEY);

    const retry = await repo.claim(KEY, { inFlightGraceMs: 0 });
    expect(retry.granted).toBe(false);
    expect(retry).toMatchObject({ status: 'done' });
  });

  it('`markDone` sur une clé jamais prise l’INSÈRE — le upsert n’exige pas de prise préalable', async () => {
    await repo.markDone('ts:D0KARYL:jamais-prise');

    const retry = await repo.claim('ts:D0KARYL:jamais-prise', { inFlightGraceMs: 0 });
    expect(retry).toMatchObject({ granted: false, status: 'done' });
  });

  it('`release` rend la clé immédiatement reprenable', async () => {
    await repo.claim(KEY, { inFlightGraceMs: GRACE_MS });
    await repo.release(KEY);

    await expect(repo.claim(KEY, { inFlightGraceMs: GRACE_MS })).resolves.toEqual({
      granted: true,
      reclaimed: false,
    });
  });

  it('`prune` rend le NOMBRE de lignes purgées, et épargne les récentes', async () => {
    await repo.claim('ts:D0:1', { inFlightGraceMs: GRACE_MS });
    await repo.claim('ts:D0:2', { inFlightGraceMs: GRACE_MS });

    expect(await repo.prune(new Date(Date.now() - 10 * 60 * 1000))).toBe(0);
    expect(await repo.prune(new Date(Date.now() + 1000))).toBe(2);
  });

  it('LE PILOTE LIBSQL RENSEIGNE BIEN `rowsAffected` — le `?? 0` n’est jamais pris', async () => {
    // ⚠️ C'est l'assertion qui rend les tests de l'étage 2 lisibles : elle établit que le repli
    // `?? 0` est aujourd'hui du code MORT en production. S'il cessait de l'être, c'est ici qu'on
    // l'apprendrait — et non par un bot silencieux.
    const db = holder.db as DatabaseInstance;
    const inserted = await db
      .insert(slackEventDedup)
      .values({ key: 'ts:D0:sonde', status: 'in-flight', startedAt: new Date() })
      .onConflictDoNothing();

    expect(typeof (inserted as { rowsAffected?: unknown }).rowsAffected).toBe('number');
    expect((inserted as { rowsAffected: number }).rowsAffected).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Étage 2 — la doublure de client, seule façon de FABRIQUER un `rowsAffected` absent.
// ────────────────────────────────────────────────────────────────────────────

type PiloteResultat = { rowsAffected?: number };

/**
 * Client Drizzle réduit à ce que `claim()` en consomme : `insert().values().onConflictDoNothing()`,
 * `update().set().where()`, `select().from().where().limit()`.
 *
 * Chaque maillon est thenable — c'est ainsi que Drizzle se comporte : on `await` le builder.
 */
function fauxClient(options: {
  insertResult: PiloteResultat;
  updateResult?: PiloteResultat;
  selectRows?: Array<{ key: string; status: string; startedAt: Date }>;
}) {
  const appels: string[] = [];
  const thenable = <T>(valeur: T) => ({
    then: (resolve: (value: T) => unknown) => Promise.resolve(valeur).then(resolve),
  });

  const db = {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => {
          appels.push('insert');
          return thenable(options.insertResult);
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => {
          appels.push('update');
          return thenable(options.updateResult ?? { rowsAffected: 0 });
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            appels.push('select');
            return thenable(options.selectRows ?? []);
          },
        }),
      }),
    }),
  };

  return { db, appels };
}

describe('DrizzleSlackEventDedupRepository — ce que dit exactement `rowsAffected`', () => {
  it('`rowsAffected: 1` sur l’INSERT ⇒ prise accordée, sans relecture', async () => {
    const { db, appels } = fauxClient({ insertResult: { rowsAffected: 1 } });
    holder.db = db;

    await expect(
      new DrizzleSlackEventDedupRepository().claim(KEY, { inFlightGraceMs: GRACE_MS }),
    ).resolves.toEqual({ granted: true, reclaimed: false });

    // La prise accordée doit coûter UN aller-retour. Le cas nominal est aussi le plus fréquent.
    expect(appels).toEqual(['insert']);
  });

  it('`rowsAffected: 0` puis `1` sur l’UPDATE ⇒ reprise d’une entrée abandonnée', async () => {
    const { db, appels } = fauxClient({
      insertResult: { rowsAffected: 0 },
      updateResult: { rowsAffected: 1 },
    });
    holder.db = db;

    await expect(
      new DrizzleSlackEventDedupRepository().claim(KEY, { inFlightGraceMs: GRACE_MS }),
    ).resolves.toEqual({ granted: true, reclaimed: true });
    expect(appels).toEqual(['insert', 'update']);
  });

  it('`rowsAffected: 0` partout ⇒ refus, avec l’état RELU pour le journal', async () => {
    const startedAt = new Date(Date.now() - 5_000);
    const { db, appels } = fauxClient({
      insertResult: { rowsAffected: 0 },
      updateResult: { rowsAffected: 0 },
      selectRows: [{ key: KEY, status: 'in-flight', startedAt }],
    });
    holder.db = db;

    const claim = await new DrizzleSlackEventDedupRepository().claim(KEY, {
      inFlightGraceMs: GRACE_MS,
    });

    expect(claim.granted).toBe(false);
    expect(claim).toMatchObject({ status: 'in-flight' });
    expect((claim as { ageMs: number }).ageMs).toBeGreaterThanOrEqual(5_000);
    // La relecture arrive APRÈS le refus, jamais avant : un SELECT en tête rouvrirait la fenêtre
    // de concurrence que toute cette table existe pour fermer.
    expect(appels).toEqual(['insert', 'update', 'select']);
  });

  it('refus + ligne INTROUVABLE ⇒ `status: "unknown"`, `ageMs: null` — jamais un âge inventé', async () => {
    const { db } = fauxClient({
      insertResult: { rowsAffected: 0 },
      updateResult: { rowsAffected: 0 },
      selectRows: [],
    });
    holder.db = db;

    await expect(
      new DrizzleSlackEventDedupRepository().claim(KEY, { inFlightGraceMs: GRACE_MS }),
    ).resolves.toEqual({ granted: false, status: 'unknown', ageMs: null });
  });

  it('⚠️ `rowsAffected` ABSENT ⇒ le `?? 0` transforme une prise RÉUSSIE en refus SILENCIEUX', async () => {
    // ⚠️ CE TEST NE VALIDE PAS UN COMPORTEMENT SOUHAITABLE — il FIGE un comportement dangereux
    // pour que sa modification soit un acte délibéré.
    //
    // Le champ manque ⇒ `rowsAffected(result)` rend 0 ⇒ le dépôt conclut « quelqu'un d'autre a
    // la clé » alors que l'INSERT vient de RÉUSSIR. Le handler écarte alors l'événement comme
    // un doublon. Généralisé, c'est un bot parfaitement muet, sans une seule ligne d'erreur :
    // même famille que `emailSent: false` sous `status: 'success'`, en pire, car ici c'est
    // 100 % du trafic qui disparaît.
    //
    // Ce n'est pas une hypothèse gratuite : le repli `?? 0` a été écrit parce que le type de
    // retour de Drizzle est `unknown` au point d'appel. Aujourd'hui `@libsql/client` renseigne
    // toujours le champ (assertion de l'étage 1) ; un changement de pilote, un enrobage de
    // tracing, ou un passage à `better-sqlite3` suffiraient à le retirer.
    const { db } = fauxClient({
      insertResult: {},
      updateResult: {},
      selectRows: [{ key: KEY, status: 'in-flight', startedAt: new Date() }],
    });
    holder.db = db;

    const claim = await new DrizzleSlackEventDedupRepository().claim(KEY, {
      inFlightGraceMs: GRACE_MS,
    });

    expect(claim.granted).toBe(false);
    expect(claim).toMatchObject({ status: 'in-flight' });
  });

  it('⚠️ `rowsAffected` absent sur `prune` ⇒ 0 purgée annoncée, purge réelle inconnue', async () => {
    // Ici la conséquence est bénigne — un chiffre faux dans un journal — mais elle est la même
    // lecture, au même endroit. La figer rend visible que les deux usages partagent un sort.
    const db = {
      delete: () => ({
        where: () => ({
          then: (resolve: (value: PiloteResultat) => unknown) => Promise.resolve({}).then(resolve),
        }),
      }),
    };
    holder.db = db;

    await expect(new DrizzleSlackEventDedupRepository().prune(new Date())).resolves.toBe(0);
  });
});

describe('DrizzlePendingInterviewEmailRepository — `clear()` rend un COMPTE, et la prise EST la suppression', () => {
  /**
   * `clear()` est la prise du chemin recrutement : on efface AVANT d'envoyer, et l'on n'envoie
   * QUE si l'on a bien pris. Deux « oui » routés vers deux instances ne peuvent donc pas envoyer
   * deux invitations — la seconde reçoit 0. Le contrat 1-puis-0 contre une vraie base est déjà
   * couvert par `tests/unit/recruitment/pending-email-repository.test.ts` ; ce qui manquait est
   * la lecture de `rowsAffected` elle-même.
   */

  async function repoSurBaseReelle(): Promise<DrizzlePendingInterviewEmailRepository> {
    client = createClient({ url: ':memory:' });
    await client.execute(createTableSql(pendingInterviewEmail));
    return new DrizzlePendingInterviewEmailRepository(
      () => drizzle(client!, { schema }) as DatabaseInstance,
    );
  }

  it('le pilote libsql renseigne `rowsAffected` sur un DELETE — 1 puis 0', async () => {
    const repo = await repoSurBaseReelle();
    await repo.save({
      conversationId: 'D0KARYL',
      requesterUserId: 'U0KARYL',
      to: 'jean@exemple.com',
      candidateName: 'Jean DUPONT',
      startsAt: '2026-09-20T13:00:00.000Z',
      position: null,
      location: null,
      replyTo: null,
      createdAt: new Date('2026-08-19T10:00:00.000Z'),
    });

    expect(await repo.clear('D0KARYL')).toBe(1);
    expect(await repo.clear('D0KARYL')).toBe(0);
  });

  it('⚠️ `rowsAffected` ABSENT ⇒ `clear()` rend 0 : l’email ne partirait JAMAIS', async () => {
    // ⚠️ Comportement FIGÉ, pas approuvé. Ici l'orientation de la panne est l'INVERSE de celle
    // du dédoublonnage, et c'est heureux : sur ce chemin, échouer vers 0 signifie « je n'ai pas
    // pris, je n'envoie pas ». Personne ne reçoit deux convocations ; quelqu'un n'en reçoit
    // aucune. C'est le bon sens de panne pour un envoi irréversible à un candidat.
    const repo = new DrizzlePendingInterviewEmailRepository(
      () =>
        ({
          delete: () => ({
            where: () => Promise.resolve({}),
          }),
        }) as unknown as DatabaseInstance,
    );

    await expect(repo.clear('D0KARYL')).resolves.toBe(0);
  });

  it('un `rowsAffected` non numérique est RAMENÉ à un nombre, jamais propagé tel quel', async () => {
    // `clear()` enveloppe sa lecture dans `Number(...)`. Le port promet `Promise<number>` et
    // l'appelant compare à 0 : une chaîne `'1'` passerait `> 0` par coercition, mais un
    // `'abc'` rendrait NaN, et `NaN > 0` est FAUX — donc pas d'envoi. Fail-closed là encore.
    const repo = new DrizzlePendingInterviewEmailRepository(
      () =>
        ({
          delete: () => ({
            where: () => Promise.resolve({ rowsAffected: '1' }),
          }),
        }) as unknown as DatabaseInstance,
    );

    const compte = await repo.clear('D0KARYL');
    expect(compte).toBe(1);
    expect(Number.isNaN(compte)).toBe(false);
  });
});

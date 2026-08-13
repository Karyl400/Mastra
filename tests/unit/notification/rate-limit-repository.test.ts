import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { getTableConfig } from 'drizzle-orm/sqlite-core';

import * as schema from '../../../src/infrastructure/database/schema';
import { rateLimitCounters } from '../../../src/infrastructure/database/schema';
import { DrizzleRateLimitRepository } from '../../../src/features/notification/infrastructure/repositories/drizzle-rate-limit.repository';
import { InMemoryRateLimitRepository } from '../../../src/features/notification/infrastructure/repositories/in-memory-rate-limit.repository';
import type { RateLimitRepository } from '../../../src/features/notification/domain/ports/rate-limit.repository';

/**
 * Le contrat de `RateLimitRepository` tient à UNE propriété : `increment()` est ATOMIQUE.
 * Tout le reste (deux clés ne se mélangent pas, la purge purge) est du confort ; c'est
 * l'atomicité qui décide si la limite est franchissable ou non par simple parallélisme.
 *
 * Elle ne se démontre pas contre un mock : un faux Drizzle exécuterait la forme qu'on lui a
 * écrite, pas celle que SQLite exécute. L'implémentation Drizzle est donc exercée contre une
 * VRAIE base libsql en mémoire, dont le DDL est DÉRIVÉ de `schema.ts`.
 *
 * Les deux implémentations passent la MÊME suite : la doublure in-memory sert de doublure
 * partout ailleurs, et si elle ne se comporte pas comme Drizzle, le run unitaire valide un
 * comportement que la production n'a pas.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Base libsql en mémoire, dont le DDL est DÉRIVÉ de `schema.ts`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Le DDL est reconstruit depuis la définition Drizzle, jamais recopié : une table de test
 * écrite à la main se désynchronise au premier changement de schéma — c'est ce genre d'écart
 * qui a fait perdre `documents.content` en silence en production.
 */
function createTableSql(): string {
  const config = getTableConfig(rateLimitCounters);

  const columns = config.columns.map((column) => {
    const parts = [`"${column.name}"`, column.getSQLType()];
    if (column.primary) parts.push('PRIMARY KEY');
    else if (column.notNull) parts.push('NOT NULL');
    if (column.isUnique) parts.push('UNIQUE');
    return parts.join(' ');
  });

  return `CREATE TABLE "${config.name}" (${columns.join(', ')})`;
}

let client: Client | null = null;
/** Toutes les requêtes SQL vues par le pilote, dans l'ordre. Sert la preuve d'atomicité. */
let executedSql: string[] = [];

async function makeDrizzleRepo(): Promise<RateLimitRepository> {
  const real = createClient({ url: ':memory:' });
  await real.execute(createTableSql());
  executedSql = [];

  // On n'intercepte pas pour simuler : la base est réelle et exécute vraiment. L'espion ne
  // sert qu'à COMPTER les allers-retours, ce qu'aucune assertion sur le résultat ne montrerait.
  const execute = real.execute.bind(real);
  const spied = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop !== 'execute') return Reflect.get(target, prop, receiver);
      // `stmt` est typé `unknown` à dessein : `execute` est surchargé (chaîne SQL, ou objet
      // `{ sql, args }`), et un `Parameters<…>` ne retiendrait qu'UNE des deux formes.
      return (stmt: unknown, ...rest: unknown[]) => {
        executedSql.push(
          typeof stmt === 'string' ? stmt : String((stmt as { sql?: string }).sql ?? ''),
        );
        return (execute as (...args: unknown[]) => unknown)(stmt, ...rest);
      };
    },
  }) as Client;

  client = real;
  const db = drizzle(spied, { schema });
  return new DrizzleRateLimitRepository(() => db);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** Instant arbitraire mais FIXE : aucun test ici ne dépend de l'horloge réelle. */
const T0 = new Date(1_700_000_000_000);
const PLUS_1_MIN = new Date(T0.getTime() + 60_000);
const PLUS_1_H = new Date(T0.getTime() + 3_600_000);

// ─────────────────────────────────────────────────────────────────────────────
// Contrat commun aux deux implémentations
// ─────────────────────────────────────────────────────────────────────────────

const implementations: Array<{ nom: string; make: () => Promise<RateLimitRepository> }> = [
  { nom: 'DrizzleRateLimitRepository', make: makeDrizzleRepo },
  { nom: 'InMemoryRateLimitRepository', make: async () => new InMemoryRateLimitRepository() },
];

describe.each(implementations)('$nom — contrat de compteur', ({ make }) => {
  let repo: RateLimitRepository;

  beforeEach(async () => {
    repo = await make();
  });

  afterEach(() => {
    client?.close();
    client = null;
  });

  it('rend 1 au premier incrément, puis 2, puis 3', async () => {
    expect(await repo.increment('burst:2:U1:0', T0, PLUS_1_MIN)).toBe(1);
    expect(await repo.increment('burst:2:U1:0', T0, PLUS_1_MIN)).toBe(2);
    expect(await repo.increment('burst:2:U1:0', T0, PLUS_1_MIN)).toBe(3);
  });

  it('ne partage aucun compteur entre deux clés', async () => {
    await repo.increment('burst:2:U1:0', T0, PLUS_1_MIN);
    await repo.increment('burst:2:U1:0', T0, PLUS_1_MIN);

    // Autre sujet, même règle et même fenêtre : compteur neuf. Sans quoi le plafond
    // « par personne » deviendrait un plafond global, et la première personne à travailler
    // le matin éteindrait le bot pour tout le monde.
    expect(await repo.increment('burst:2:U2:0', T0, PLUS_1_MIN)).toBe(1);
    // Même sujet, fenêtre suivante : compteur neuf lui aussi — c'est la clé qui remet à zéro,
    // aucun code ne le fait.
    expect(await repo.increment('burst:2:U1:1', PLUS_1_MIN, PLUS_1_H)).toBe(1);
    // Et la première clé n'a pas bougé.
    expect(await repo.increment('burst:2:U1:0', T0, PLUS_1_MIN)).toBe(3);
  });

  it('ne repousse pas l’expiration à chaque incrément', async () => {
    await repo.increment('burst:2:U1:0', T0, PLUS_1_MIN);
    // Un appelant qui recalculerait une expiration plus lointaine ne doit PAS prolonger la
    // ligne : une clé très sollicitée survivrait indéfiniment à sa propre fenêtre.
    await repo.increment('burst:2:U1:0', T0, PLUS_1_H);

    expect(await repo.prune(PLUS_1_MIN)).toBe(1);
  });

  it('purge les fenêtres expirées et ÉPARGNE les vivantes', async () => {
    await repo.increment('expire:1', T0, PLUS_1_MIN);
    await repo.increment('vivante:1', T0, PLUS_1_H);

    const supprimees = await repo.prune(new Date(PLUS_1_MIN.getTime() + 1));

    expect(supprimees).toBe(1);
    // La ligne expirée a bien disparu : son compteur repart à 1.
    expect(await repo.increment('expire:1', T0, PLUS_1_H)).toBe(1);
    // La vivante, elle, a été épargnée : elle continue à compter.
    expect(await repo.increment('vivante:1', T0, PLUS_1_H)).toBe(2);
  });

  it('purge une ligne dont l’expiration tombe EXACTEMENT sur l’instant demandé', async () => {
    await repo.increment('pile:1', T0, PLUS_1_MIN);

    // `expiresAt` porte déjà la marge de purge de `rate-limit-policy.ts` : une ligne dont
    // l'expiration est atteinte n'a plus rien à protéger.
    expect(await repo.prune(PLUS_1_MIN)).toBe(1);
  });

  it('rend 0 quand il n’y a rien à purger', async () => {
    await repo.increment('vivante:1', T0, PLUS_1_H);
    expect(await repo.prune(T0)).toBe(0);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // LE test : c'est lui qui prouve le contrat
  // ───────────────────────────────────────────────────────────────────────────

  it('sous concurrence, rend exactement 1..N sur la MÊME clé — aucune valeur perdue ni répétée', async () => {
    const N = 25;

    const valeurs = await Promise.all(
      Array.from({ length: N }, () => repo.increment('rafale:1', T0, PLUS_1_H)),
    );

    // Un `SELECT` suivi d'un `UPDATE` produirait ici des doublons et un maximum < N : deux
    // appels liraient la même valeur avant que l'un écrive. C'est LA faille que ce port ferme,
    // et le seul symptôme observable en est la répétition d'une valeur rendue.
    expect(Math.max(...valeurs)).toBe(N);
    expect(new Set(valeurs).size).toBe(N);
    expect([...valeurs].sort((a, b) => a - b)).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Propriétés qui ne se démontrent que contre du vrai SQL
// ─────────────────────────────────────────────────────────────────────────────

describe('DrizzleRateLimitRepository — un SEUL énoncé, et il est le bon', () => {
  let repo: RateLimitRepository;

  beforeEach(async () => {
    repo = await makeDrizzleRepo();
  });

  afterEach(() => {
    client?.close();
    client = null;
  });

  it('n’émet qu’UNE requête par incrément, upsert avec RETURNING', async () => {
    await repo.increment('solo:1', T0, PLUS_1_H);

    // Le compte d'allers-retours EST le contrat : deux requêtes signifieraient un `SELECT`
    // puis un `UPDATE`, donc une fenêtre de concurrence rouverte. Et ce chemin tourne avant
    // l'ACK Slack, qui n'a que 3 secondes.
    expect(executedSql).toHaveLength(1);

    const sql = executedSql[0].toLowerCase();
    expect(sql).toContain('insert into');
    expect(sql).toContain('on conflict');
    expect(sql).toContain('do update set');
    // Le pas est PARAMÉTRÉ (`+ ?`) depuis que `increment` en accepte un — c'était `+ 1` en
    // dur. Ce qui porte la propriété est que l'incrément se fasse DANS l'énoncé, pas sa
    // valeur : un pas lié est strictement préférable à un littéral interpolé.
    expect(sql).toMatch(/"count"\s*\+\s*\?/);
    expect(sql).toContain('returning');
    // Aucune lecture préalable : la valeur rendue vient de l'UPDATE lui-même.
    expect(sql).not.toContain('select');
  });

  it('n’émet toujours qu’UNE requête quand la ligne existe déjà', async () => {
    await repo.increment('solo:1', T0, PLUS_1_H);
    executedSql = [];

    await repo.increment('solo:1', T0, PLUS_1_H);

    expect(executedSql).toHaveLength(1);
  });

  it('écrit réellement la fenêtre en base, et ne la réécrit pas sur conflit', async () => {
    await repo.increment('fenetre:1', T0, PLUS_1_MIN);
    await repo.increment('fenetre:1', PLUS_1_H, PLUS_1_H);

    const rows = await client!.execute({
      sql: 'SELECT count, window_start, expires_at FROM rate_limit_counters WHERE key = ?',
      args: ['fenetre:1'],
    });

    expect(rows.rows).toHaveLength(1);
    expect(Number(rows.rows[0].count)).toBe(2);
    // `window_start` et `expires_at` sont ceux du PREMIER incrément : la clé porte déjà le
    // numéro de fenêtre, les réécrire ne pourrait que prolonger indûment la ligne.
    expect(Number(rows.rows[0].window_start)).toBe(T0.getTime());
    expect(Number(rows.rows[0].expires_at)).toBe(PLUS_1_MIN.getTime());
  });

  it('supprime physiquement les lignes purgées', async () => {
    await repo.increment('mort:1', T0, PLUS_1_MIN);
    await repo.increment('vif:1', T0, PLUS_1_H);

    await repo.prune(PLUS_1_MIN);

    const rows = await client!.execute('SELECT key FROM rate_limit_counters');
    expect(rows.rows.map((r) => r.key)).toEqual(['vif:1']);
  });
});

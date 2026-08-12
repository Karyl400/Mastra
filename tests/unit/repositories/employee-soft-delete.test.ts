import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { getTableConfig } from 'drizzle-orm/sqlite-core';

import * as schema from '../../../src/infrastructure/database/schema';
import { employees } from '../../../src/infrastructure/database/schema';
import { DrizzleEmployeeRepository } from '../../../src/features/employee/infrastructure/repositories/drizzle-employee.repository';
import { InMemoryEmployeeRepository } from '../../../src/features/employee/infrastructure/repositories/in-memory-employee.repository';
import {
  createEmployee,
  type Employee,
} from '../../../src/features/employee/domain/entities/employee';
import type { EmployeeRepository } from '../../../src/features/employee/domain/ports/employee.repository';
import { ConflictError } from '../../../src/shared/errors';

/**
 * `employees.deleted_at` existe dans `schema.ts` — avec son propre index — depuis l'origine,
 * mais `delete()` faisait un DELETE PHYSIQUE : l'index était 100 % mort et toute suppression
 * détruisait la donnée sans trace ni réversibilité.
 *
 * Ces tests verrouillent le contrat des DEUX implémentations. La doublure in-memory sert de
 * doublure à tous les tests de tools : si elle ne se comporte pas comme Drizzle, le run unitaire
 * valide un comportement que la production n'a pas.
 *
 * L'implémentation Drizzle est exercée contre une VRAIE base libsql en mémoire — on ne mocke
 * jamais Drizzle à la main, et « la ligne existe encore avec `deleted_at` non nul » ne se
 * démontre que contre du vrai SQL.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Base libsql en mémoire, dont le DDL est DÉRIVÉ de `schema.ts`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Le DDL est reconstruit depuis la définition Drizzle, jamais recopié : une table de test
 * écrite à la main se désynchronise au premier changement de schéma, et c'est exactement ce
 * genre d'écart qui a fait perdre en silence `documents.content` en production.
 */
function createTableSql(): string {
  const config = getTableConfig(employees);

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

async function makeDrizzleRepo(): Promise<EmployeeRepository> {
  client = createClient({ url: ':memory:' });
  await client.execute(createTableSql());
  const db = drizzle(client, { schema });
  return new DrizzleEmployeeRepository(() => db);
}

async function deletedAtInDb(id: string): Promise<string | null> {
  const result = await client!.execute({
    sql: 'SELECT deleted_at FROM employees WHERE id = ?',
    args: [id],
  });
  if (result.rows.length === 0) return null;
  return (result.rows[0].deleted_at as string | null) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function employe(id: string, email: string): Employee {
  return createEmployee({
    id,
    firstName: 'Awa',
    lastName: 'Diop',
    email,
    department: 'RH',
    position: 'Chargée de mission',
    startDate: '2026-09-01',
    managerId: null,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Contrat commun aux deux implémentations
// ─────────────────────────────────────────────────────────────────────────────

const implementations: Array<{ nom: string; make: () => Promise<EmployeeRepository> }> = [
  { nom: 'DrizzleEmployeeRepository', make: makeDrizzleRepo },
  { nom: 'InMemoryEmployeeRepository', make: async () => new InMemoryEmployeeRepository() },
];

describe.each(implementations)('$nom — contrat de soft delete', ({ make }) => {
  let repo: EmployeeRepository;

  beforeEach(async () => {
    repo = await make();
  });

  afterEach(() => {
    client?.close();
    client = null;
  });

  it('rend la ligne invisible à findById après delete()', async () => {
    await repo.save(employe('emp-1', 'awa.diop@kisso.com'));
    expect(await repo.findById('emp-1')).not.toBeNull();

    await repo.delete('emp-1');

    expect(await repo.findById('emp-1')).toBeNull();
  });

  it('rend la ligne invisible à findByEmail après delete()', async () => {
    await repo.save(employe('emp-2', 'awa.diop@kisso.com'));

    await repo.delete('emp-2');

    expect(await repo.findByEmail('awa.diop@kisso.com')).toBeNull();
  });

  it('exclut la ligne supprimée de findAll(), sans toucher aux autres', async () => {
    await repo.save(employe('emp-3', 'awa.diop@kisso.com'));
    await repo.save(employe('emp-4', 'moussa.fall@kisso.com'));

    await repo.delete('emp-3');

    const tous = await repo.findAll();
    expect(tous.map((e) => e.id)).toEqual(['emp-4']);
  });

  it('supprimer un identifiant inconnu ne lève pas', async () => {
    await expect(repo.delete('emp-inexistant')).resolves.toBeUndefined();
  });

  it('ne ressuscite pas une fiche supprimée par un simple update()', async () => {
    await repo.save(employe('emp-5', 'awa.diop@kisso.com'));
    await repo.delete('emp-5');

    // `update()` délègue à l'upsert, donc il retombe sur la ligne supprimée. Côté SQL,
    // l'upsert ne NOMME pas `deleted_at` : la colonne reste intacte. La doublure doit dire la
    // même chose, sans quoi une réapparition passerait inaperçue en test et pas en production.
    await repo.update(employe('emp-5', 'awa.diop@kisso.com'));

    expect(await repo.findById('emp-5')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Propriétés qui ne se démontrent que contre du vrai SQL
// ─────────────────────────────────────────────────────────────────────────────

describe('DrizzleEmployeeRepository — la donnée SURVIT à la suppression', () => {
  let repo: EmployeeRepository;

  beforeEach(async () => {
    repo = await makeDrizzleRepo();
  });

  afterEach(() => {
    client?.close();
    client = null;
  });

  it('conserve la ligne en base, horodatée dans deleted_at', async () => {
    await repo.save(employe('emp-10', 'awa.diop@kisso.com'));

    await repo.delete('emp-10');

    const rows = await client!.execute({
      sql: 'SELECT id, email, deleted_at FROM employees WHERE id = ?',
      args: ['emp-10'],
    });

    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].email).toBe('awa.diop@kisso.com');
    expect(rows.rows[0].deleted_at).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(rows.rows[0].deleted_at as string))).toBe(false);
  });

  it('ne réécrit pas la date de suppression sur un second delete()', async () => {
    await repo.save(employe('emp-11', 'awa.diop@kisso.com'));
    await repo.delete('emp-11');
    const premier = await deletedAtInDb('emp-11');

    await repo.delete('emp-11');

    // Un second appel ne doit pas déplacer la date : c'est la trace de la suppression
    // ORIGINELLE, seule information réutilisable pour un audit ou une restauration.
    expect(await deletedAtInDb('emp-11')).toBe(premier);
  });

  it("refuse BRUYAMMENT de recréer un employé sur l'email d'une ligne supprimée", async () => {
    await repo.save(employe('emp-20', 'awa.diop@kisso.com'));
    await repo.delete('emp-20');

    // La ligne supprimée OCCUPE toujours l'email (contrainte UNIQUE). Le hard delete le
    // permettait ; le soft delete ne le peut pas. La seule option inacceptable serait un échec
    // silencieux — on veut donc une erreur, et une erreur qui NOMME la cause.
    await expect(repo.save(employe('emp-21', 'awa.diop@kisso.com'))).rejects.toBeInstanceOf(
      ConflictError,
    );

    await expect(repo.save(employe('emp-22', 'awa.diop@kisso.com'))).rejects.toThrow(/supprim/i);
  });

  it("laisse remonter le conflit d'email brut quand la ligne en place est VIVANTE", async () => {
    await repo.save(employe('emp-30', 'awa.diop@kisso.com'));

    // Deux employés vivants sur la même adresse : c'est un doublon ordinaire, pas une
    // conséquence du soft delete. Le message ne doit donc pas parler de suppression.
    await expect(repo.save(employe('emp-31', 'awa.diop@kisso.com'))).rejects.toThrow();
    await expect(repo.save(employe('emp-32', 'awa.diop@kisso.com'))).rejects.not.toThrow(
      /supprim/i,
    );
  });

  it('met à jour un employé existant sans le ressusciter par accident', async () => {
    await repo.save(employe('emp-40', 'awa.diop@kisso.com'));
    await repo.delete('emp-40');

    // `update()` délègue à `save()`, donc un upsert sur le MÊME id retombe sur la ligne
    // supprimée. Il ne doit pas la faire réapparaître à l'insu de l'appelant : la
    // réactivation, si elle doit exister un jour, sera un geste EXPLICITE.
    await repo.update(employe('emp-40', 'awa.diop@kisso.com'));

    expect(await repo.findById('emp-40')).toBeNull();
    expect(await deletedAtInDb('emp-40')).toEqual(expect.any(String));
  });
});

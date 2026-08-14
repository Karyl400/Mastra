import { describe, it, expect, beforeEach } from 'vitest';

import { makeFindPersonByName } from '../../../src/features/employee/application/tools/find-person-by-name';
import { InMemoryEmployeeRepository } from '../../../src/features/employee/infrastructure/repositories/in-memory-employee.repository';
import { InMemoryDirectoryRepository } from '../../../src/features/directory/infrastructure/repositories/in-memory-directory.repository';
import type { Employee } from '../../../src/features/employee/domain/entities/employee';
import type { DirectoryMemberFacts } from '../../../src/features/directory/domain/entities/directory-member';
import { EmployeeStatus } from '../../../src/shared/types';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * Le bug que ce tool corrige, relevé sur la Turso de production le 2026-08-13
 * ════════════════════════════════════════════════════════════════════════════
 *
 *   employee_id=d20df236…(Karyl)  type=welcome_letter  title="Bienvenue Awa"  status=sent
 *
 * Le document « Bienvenue Awa » porte l'UUID de Karyl et son email est parti à l'adresse
 * de Karyl. Awa a pourtant sa propre ligne `employees` — mais elle est ABSENTE de
 * `slack_directory`, et aucun tool ne savait résoudre un prénom. Le modèle a réutilisé le
 * seul UUID de son contexte.
 *
 * D'où les deux propriétés que ces tests verrouillent avant toute autre :
 *   1. les DEUX sources sont interrogées, `employees` d'abord ;
 *   2. sur ambiguïté, AUCUN identifiant ne sort — le modèle doit demander, pas choisir.
 */

const KARYL = 'd20df236-5c24-42a5-b205-d0d738d34fb4';
const AWA = 'd36b78dc-a039-4160-b86a-bd3d2a722b6c';

function employee(id: string, firstName: string, lastName: string): Employee {
  return {
    id,
    firstName,
    lastName,
    email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@kisso.com`,
    department: null,
    position: 'Developer',
    startDate: '2026-09-01T00:00:00.000Z',
    status: EmployeeStatus.Pending,
    managerId: null,
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
  };
}

function member(overrides: Partial<DirectoryMemberFacts> & { slackUserId: string }) {
  return {
    teamId: 'TMLKC4EPP',
    email: null,
    realName: '',
    displayName: '',
    firstName: null,
    lastName: null,
    title: null,
    isBot: false,
    isAdmin: false,
    isRestricted: false,
    isUltraRestricted: false,
    isDeleted: false,
    ...overrides,
  } as DirectoryMemberFacts;
}

let employees: InMemoryEmployeeRepository;
let directory: InMemoryDirectoryRepository;

beforeEach(() => {
  employees = new InMemoryEmployeeRepository();
  directory = new InMemoryDirectoryRepository();
});

function tool() {
  return makeFindPersonByName(employees, directory);
}

async function run(name: string) {
  return (await tool().execute!({ name } as never, {} as never)) as Record<string, unknown>;
}

describe('findPersonByName — résolution depuis employees', () => {
  beforeEach(async () => {
    await employees.save(employee(AWA, 'Awa', 'TRAORE'));
    await employees.save(employee(KARYL, 'Karyl', 'SOUMAILA'));
  });

  it("rend l'UUID interne d'un employé résolu par son prénom", async () => {
    const result = await run('Awa');

    expect(result.found).toBe(true);
    expect(result.source).toBe('employees');
    expect(result.employee).toMatchObject({ id: AWA, firstName: 'Awa', lastName: 'TRAORE' });
  });

  it('résout aussi par nom complet et par nom de famille seul', async () => {
    expect((await run('Awa TRAORE')).employee).toMatchObject({ id: AWA });
    expect((await run('traore')).employee).toMatchObject({ id: AWA });
  });

  it("n'expose PAS l'email dans le résultat", async () => {
    // Même règle que `findEmployeeByEmail` : ce tool lève une ambiguïté d'identité, il
    // n'est pas un canal de sortie de données personnelles. Il est atteignable par
    // n'importe quel membre du workspace.
    const serialise = JSON.stringify(await run('Awa'));

    expect(serialise).not.toContain('@kisso.com');
  });
});

describe('findPersonByName — repli sur l’annuaire Slack', () => {
  it("résout une personne qui n'existe que dans l'annuaire", async () => {
    await directory.upsertFacts(
      member({
        slackUserId: 'UMPG7HWRL',
        firstName: 'Pamela',
        lastName: 'Fourn',
        displayName: 'Pamela Fourn',
        realName: 'Pamela Fourn',
        title: 'Product Manager',
      }),
      new Date(),
    );

    const result = await run('Pamela');

    expect(result.found).toBe(true);
    expect(result.source).toBe('slack_directory');
    expect(result.person).toMatchObject({ slackUserId: 'UMPG7HWRL', employeeId: null });
    // Sans ce hint, le modèle croit tenir une personne pleinement exploitable et
    // enchaîne sur `getEmployeeProfile`, qui exige un UUID interne inexistant.
    expect(result.hint).toMatch(/dossier d'onboarding/i);
  });

  it('donne la PRIORITÉ à employees quand les deux sources répondent', async () => {
    // `employees` porte l'UUID interne dont dépendent generateDocument et scheduleReminder.
    // L'ordre inverse ferait perdre cet identifiant pour un employé pourtant enregistré.
    await employees.save(employee(KARYL, 'Karyl', 'SOUMAILA'));
    await directory.upsertFacts(
      member({ slackUserId: 'U0BJBDGTJUD', firstName: 'Karyl', lastName: 'SOUMAILA' }),
      new Date(),
    );

    const result = await run('Karyl');

    expect(result.source).toBe('employees');
  });

  it('écarte les bots et les comptes désactivés', async () => {
    // Le workspace de production porte 22 bots sur 40 lignes. Les rendre inviterait le
    // modèle à leur proposer un document d'accueil.
    await directory.upsertFacts(
      member({ slackUserId: 'U0BOT', firstName: 'Kaido', displayName: 'Kaido', isBot: true }),
      new Date(),
    );
    await directory.upsertFacts(
      member({ slackUserId: 'U0OLD', firstName: 'Alexis', displayName: 'Alexis', isDeleted: true }),
      new Date(),
    );

    expect((await run('Kaido')).found).toBe(false);
    expect((await run('Alexis')).found).toBe(false);
  });
});

describe('findPersonByName — ambiguïté', () => {
  beforeEach(async () => {
    await employees.save(employee(AWA, 'Awa', 'TRAORE'));
    await employees.save(employee('11111111-1111-4111-8111-111111111111', 'Awa', 'DIALLO'));
  });

  it('refuse de choisir et rend les candidats', async () => {
    const result = await run('Awa');

    expect(result.found).toBe(false);
    expect(result.reason).toBe('ambiguous');
    expect(result.candidates).toHaveLength(2);
  });

  it('ne laisse échapper AUCUN identifiant dans la liste des candidats', async () => {
    // La garantie centrale de ce tool. Rendre deux UUID reviendrait à laisser le modèle en
    // choisir un — c'est-à-dire exactement le geste qui a envoyé le document d'Awa à
    // l'adresse de Karyl. Il doit demander laquelle des deux.
    const result = await run('Awa');
    const serialise = JSON.stringify(result);

    expect(serialise).not.toContain(AWA);
    expect(serialise).not.toContain('11111111-1111-4111-8111-111111111111');
    expect(result.hint).toMatch(/demande/i);
  });

  it('lève l’ambiguïté dès que la requête se précise', async () => {
    const result = await run('Awa TRAORE');

    expect(result.found).toBe(true);
    expect(result.employee).toMatchObject({ id: AWA });
  });
});

describe('findPersonByName — cas vides et bornes', () => {
  it('rend found=false sans lever quand personne ne correspond', async () => {
    const result = await run('Ridwane');

    expect(result.found).toBe(false);
    expect(result.reason).toBe('no_match');
    expect(result.hint).toBeTruthy();
  });

  it('borne les candidats et le dit', async () => {
    for (let i = 0; i < 9; i++) {
      await employees.save(employee(`2222222${i}-2222-4222-8222-222222222222`, 'Awa', `NOM${i}`));
    }

    const result = await run('Awa');

    expect(result.reason).toBe('ambiguous');
    expect((result.candidates as unknown[]).length).toBeLessThanOrEqual(5);
    expect(result.truncated).toBe(true);
  });

  it('tient sous 120 tokens même en cas ambigu', async () => {
    for (let i = 0; i < 9; i++) {
      await employees.save(employee(`2222222${i}-2222-4222-8222-222222222222`, 'Awa', `NOM${i}`));
    }

    const serialise = JSON.stringify(await run('Awa'));
    const tokens = Math.round(serialise.length / 3.5);

    // Ce résultat entre dans l'historique et est réémis à chaque aller-retour suivant, sur
    // un budget de ≈ 19 messages par jour.
    expect(tokens, `tool-result de ${tokens} tokens`).toBeLessThan(120);
  });

  it('fonctionne sans annuaire câblé', async () => {
    // Playground, base neuve, tests : le tool doit rester appelable avec la seule table
    // `employees`, comme `findEmployeeByEmail`.
    await employees.save(employee(AWA, 'Awa', 'TRAORE'));
    const sansAnnuaire = makeFindPersonByName(employees);

    const result = (await sansAnnuaire.execute!({ name: 'Awa' } as never, {} as never)) as Record<
      string,
      unknown
    >;

    expect(result.found).toBe(true);
  });
});

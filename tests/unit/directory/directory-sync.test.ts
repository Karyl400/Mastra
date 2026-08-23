import { describe, it, expect, vi } from 'vitest';

import { makeDirectorySync } from '../../../src/features/directory/application/services/directory-sync.service';
import type {
  DirectorySyncSource,
  EmployeeDirectoryLookup,
} from '../../../src/features/directory/application/services/directory-sync.service';
import { InMemoryDirectoryRepository } from '../../../src/features/directory/infrastructure/repositories/in-memory-directory.repository';
import type { DirectoryMemberFacts } from '../../../src/features/directory/domain/entities/directory-member';
import type { DirectoryRepository } from '../../../src/features/directory/domain/ports/directory.repository';

/**
 * La synchronisation de l'annuaire.
 *
 * LE test de ce fichier est le premier : une resynchronisation NE DOIT PAS effacer
 * `dm_channel_id` ni `employee_id`. Le canal de DM ne se redécouvre pas — Slack refuse de le
 * lister (`conversations.list({types:'im'})` → `missing_scope`, il faudrait `im:read`, non
 * accordé) — donc une valeur perdue l'est définitivement. C'est le mode d'échec de
 * `documents.content`, transposé.
 *
 * La doublure est `InMemoryDirectoryRepository`, qui reproduit exactement la non-destruction de
 * l'implémentation Drizzle (les deux sont déjà verrouillées par la même suite dans
 * `directory-repository.test.ts`). On ne mocke jamais Drizzle à la main.
 */

function facts(overrides: Partial<DirectoryMemberFacts> = {}): DirectoryMemberFacts {
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

function makeSource(members: DirectoryMemberFacts[], truncated?: boolean): DirectorySyncSource {
  return {
    findAll: vi.fn(async () => members),
    findById: vi.fn(async () => null),
    ...(truncated === undefined ? {} : { wasLastFetchTruncated: () => truncated }),
  };
}

describe('Directory: synchronisation', () => {
  it("N'EFFACE PAS le canal de DM appris ni le rattachement employé", async () => {
    const repo = new InMemoryDirectoryRepository();
    await repo.upsertFacts(facts(), new Date('2026-08-01'));
    await repo.rememberDmChannel('U0AWA', 'D0AWA');
    await repo.linkEmployee('U0AWA', 'emp-1');

    const sync = makeDirectorySync({
      source: makeSource([facts({ realName: 'Awa D.' })]),
      repository: repo,
      now: () => new Date('2026-08-12'),
    });
    const report = await sync.run();

    const member = await repo.findBySlackUserId('U0AWA');
    expect(member?.dmChannelId).toBe('D0AWA');
    expect(member?.employeeId).toBe('emp-1');
    expect(member?.firstSeenAt).toEqual(new Date('2026-08-01'));
    // Les faits de Slack, eux, sont bien rafraîchis.
    expect(member?.realName).toBe('Awa D.');
    expect(member?.syncedAt).toEqual(new Date('2026-08-12'));
    expect(report.outcome).toBe('completed');
  });

  it('est idempotente : deux passages laissent le même état', async () => {
    const repo = new InMemoryDirectoryRepository();
    const sync = makeDirectorySync({
      source: makeSource([facts(), facts({ slackUserId: 'U0BOB', email: 'bob@kissohq.com' })]),
      repository: repo,
      now: () => new Date('2026-08-12'),
    });

    await sync.run();
    const first = await repo.findAll();
    const second = await sync.run();

    expect(second.scanned).toBe(2);
    expect(second.upserted).toBe(2);
    expect(await repo.findAll()).toEqual(first);
  });

  it('isole les échecs : un membre en erreur n emporte pas les autres', async () => {
    const repo = new InMemoryDirectoryRepository();
    const failing: DirectoryRepository = {
      hasManager: async () => false,
      findManagers: async () => [],
      upsertFacts: vi.fn(async (f: DirectoryMemberFacts, now: Date) => {
        if (f.slackUserId === 'U-KO')
          throw new Error('SQLITE_ERROR: no such table: slack_directory');
        await repo.upsertFacts(f, now);
      }),
      findBySlackUserId: (id: string) => repo.findBySlackUserId(id),
      findByEmail: (e: string) => repo.findByEmail(e),
      findByName: (q: string, n: number) => repo.findByName(q, n),
      rememberDmChannel: (id: string, dm: string) => repo.rememberDmChannel(id, dm),
      linkEmployee: (id: string, emp: string | null) => repo.linkEmployee(id, emp),
      findAll: () => repo.findAll(),
    };

    const sync = makeDirectorySync({
      source: makeSource([facts({ slackUserId: 'U-OK' }), facts({ slackUserId: 'U-KO' })]),
      repository: failing,
    });
    const report = await sync.run();

    expect(report.outcome).toBe('degraded');
    expect(report.upserted).toBe(1);
    expect(report.failureCount).toBe(1);
    expect(report.failures[0]?.slackUserId).toBe('U-KO');
    // La cause est NOMMÉE dans le rapport : c'est elle qui désigne le DDL non appliqué.
    expect(report.failures[0]?.error).toContain('no such table');
    expect(await repo.findBySlackUserId('U-OK')).not.toBeNull();
  });

  it('borne l échantillon d échecs sans fausser le décompte', async () => {
    const repo = new InMemoryDirectoryRepository();
    const always: DirectoryRepository = {
      hasManager: async () => false,
      findManagers: async () => [],
      upsertFacts: vi.fn(async () => {
        throw new Error('no such table: slack_directory');
      }),
      findAll: () => repo.findAll(),
      findBySlackUserId: (id: string) => repo.findBySlackUserId(id),
      findByEmail: (e: string) => repo.findByEmail(e),
      findByName: (q: string, n: number) => repo.findByName(q, n),
      rememberDmChannel: (id: string, dm: string) => repo.rememberDmChannel(id, dm),
      linkEmployee: (id: string, emp: string | null) => repo.linkEmployee(id, emp),
    };

    const members = Array.from({ length: 25 }, (_, i) => facts({ slackUserId: `U${i}` }));
    const report = await makeDirectorySync({
      source: makeSource(members),
      repository: always,
    }).run();

    expect(report.failureCount).toBe(25);
    expect(report.failures).toHaveLength(10);
    expect(report.outcome).toBe('degraded');
  });

  it('rattache employee_id par email, sans jamais détacher', async () => {
    const repo = new InMemoryDirectoryRepository();
    const employees: EmployeeDirectoryLookup = {
      findByEmail: vi.fn(async (email: string) =>
        email === 'awa.diop@kissohq.com' ? { id: 'emp-42' } : null,
      ),
    };

    const sync = makeDirectorySync({
      source: makeSource([facts(), facts({ slackUserId: 'U0BOB', email: 'externe@ailleurs.com' })]),
      repository: repo,
      employees,
    });
    const report = await sync.run();

    expect(report.linked).toBe(1);
    expect((await repo.findBySlackUserId('U0AWA'))?.employeeId).toBe('emp-42');
    expect((await repo.findBySlackUserId('U0BOB'))?.employeeId).toBeNull();

    // Second passage : l'employé n'est plus résolvable (base indisponible, email modifié…).
    const flaky: EmployeeDirectoryLookup = { findByEmail: vi.fn(async () => null) };
    const again = makeDirectorySync({
      source: makeSource([facts()]),
      repository: repo,
      employees: flaky,
    });
    await again.run();

    // Le pont vers le métier SURVIT : un détachement automatique se déclencherait au premier
    // email introuvable et personne ne le verrait.
    expect((await repo.findBySlackUserId('U0AWA'))?.employeeId).toBe('emp-42');
  });

  it('ne relance pas la résolution employé pour un membre déjà rattaché', async () => {
    const repo = new InMemoryDirectoryRepository();
    await repo.upsertFacts(facts(), new Date('2026-08-01'));
    await repo.linkEmployee('U0AWA', 'emp-1');

    const employees: EmployeeDirectoryLookup = {
      findByEmail: vi.fn(async () => ({ id: 'emp-1' })),
    };
    await makeDirectorySync({ source: makeSource([facts()]), repository: repo, employees }).run();

    expect(employees.findByEmail).not.toHaveBeenCalled();
  });

  it('ne résout ni les bots, ni les comptes désactivés, ni les membres sans email', async () => {
    const repo = new InMemoryDirectoryRepository();
    const employees: EmployeeDirectoryLookup = {
      findByEmail: vi.fn(async () => ({ id: 'emp-1' })),
    };

    await makeDirectorySync({
      source: makeSource([
        facts({ slackUserId: 'UBOT', isBot: true, email: null }),
        facts({ slackUserId: 'UOLD', isDeleted: true }),
        facts({ slackUserId: 'UNOEMAIL', email: null }),
      ]),
      repository: repo,
      employees,
    }).run();

    expect(employees.findByEmail).not.toHaveBeenCalled();
    // Ils SONT en revanche enregistrés : c'est ce qui permet de les refuser.
    expect((await repo.findAll()).map((m) => m.slackUserId)).toEqual(['UBOT', 'UNOEMAIL', 'UOLD']);
  });

  it("n'échoue pas quand aucun annuaire employé n'est câblé", async () => {
    const repo = new InMemoryDirectoryRepository();
    const report = await makeDirectorySync({
      source: makeSource([facts()]),
      repository: repo,
    }).run();

    // « Non applicable » n'est pas « dégradé » — le même arbitrage que l'invitation Slack.
    expect(report.outcome).toBe('completed');
    expect(report.linked).toBe(0);
  });

  it('compte un rattachement en échec comme une dégradation', async () => {
    const repo = new InMemoryDirectoryRepository();
    const employees: EmployeeDirectoryLookup = {
      findByEmail: vi.fn(async () => {
        throw new Error('employees table unreachable');
      }),
    };

    const report = await makeDirectorySync({
      source: makeSource([facts()]),
      repository: repo,
      employees,
    }).run();

    expect(report.linkFailures).toBe(1);
    expect(report.outcome).toBe('degraded');
    // L'annuaire, lui, est bien écrit : la dégradation est partielle et nommée.
    expect(report.upserted).toBe(1);
  });

  it('reporte la troncature du balayage comme une dégradation', async () => {
    const repo = new InMemoryDirectoryRepository();
    const report = await makeDirectorySync({
      source: makeSource([facts()], true),
      repository: repo,
    }).run();

    expect(report.truncated).toBe(true);
    // « 1 membre synchronisé » sans cette mention se lirait « le workspace en compte 1 ».
    expect(report.outcome).toBe('degraded');
  });

  it('reste utilisable avec une source muette sur la troncature', async () => {
    const repo = new InMemoryDirectoryRepository();
    const report = await makeDirectorySync({
      source: makeSource([facts()]),
      repository: repo,
    }).run();

    expect(report.truncated).toBe(false);
    expect(report.outcome).toBe('completed');
  });

  it('survit à une lecture des rattachements existants en échec', async () => {
    const repo = new InMemoryDirectoryRepository();
    const broken: DirectoryRepository = {
      hasManager: async () => false,
      findManagers: async () => [],
      upsertFacts: (f: DirectoryMemberFacts, now: Date) => repo.upsertFacts(f, now),
      findBySlackUserId: (id: string) => repo.findBySlackUserId(id),
      findByEmail: (e: string) => repo.findByEmail(e),
      findByName: (q: string, n: number) => repo.findByName(q, n),
      rememberDmChannel: (id: string, dm: string) => repo.rememberDmChannel(id, dm),
      linkEmployee: (id: string, emp: string | null) => repo.linkEmployee(id, emp),
      findAll: vi.fn(async () => {
        throw new Error('findAll unavailable');
      }),
    };

    const report = await makeDirectorySync({
      source: makeSource([facts()]),
      repository: broken,
    }).run();

    expect(report.upserted).toBe(1);
    expect(report.outcome).toBe('completed');
  });
});

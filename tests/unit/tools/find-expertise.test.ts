import { describe, it, expect, vi } from 'vitest';

import { makeFindExpertise } from '../../../src/features/knowledge/application/tools/find-expertise';
import { InMemoryDirectoryRepository } from '../../../src/features/directory/infrastructure/repositories/in-memory-directory.repository';
import { InMemoryEmployeeRepository } from '../../../src/features/employee/infrastructure/repositories/in-memory-employee.repository';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * « savoir QUI PEUT FAIRE QUOI » — la demande n°8, et le seul manque du
 * `knowledgeAgent` qui ne soit pas un problème de routage
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Le workspace sait déjà qui fait quoi : `slack_directory.title` porte le poste déclaré dans
 * Slack (40 lignes au 2026-08-14) et `employees.position` celui du dossier (2 lignes). Aucun
 * tool ne savait interroger ni l'un ni l'autre — « qui s'occupe du backend ? » n'avait donc
 * qu'une réponse possible, celle que le modèle inventait.
 */

function member(over: Partial<Record<string, unknown>>) {
  return {
    slackUserId: 'U1',
    teamId: 'T1',
    email: null,
    realName: 'Sans Nom',
    displayName: '',
    firstName: null,
    lastName: null,
    title: null,
    isBot: false,
    isAdmin: false,
    isRestricted: false,
    isUltraRestricted: false,
    isDeleted: false,
    dmChannelId: null,
    employeeId: null,
    ...over,
  } as never;
}

async function directoryWith(members: ReadonlyArray<Record<string, unknown>>) {
  const repo = new InMemoryDirectoryRepository();
  const now = new Date();
  for (const m of members) {
    await repo.upsertFacts(m as never, now);
  }
  return repo;
}

const noEmployees = { findAll: vi.fn().mockResolvedValue([]) } as never;

describe('findExpertise', () => {
  it('retrouve une personne par son POSTE déclaré dans Slack', async () => {
    const directoryRepo = await directoryWith([
      member({ slackUserId: 'U1', realName: 'Pamela KONE', title: 'Backend Developer' }),
      member({ slackUserId: 'U2', realName: 'Nazer BAH', title: 'Designer' }),
    ]);
    const tool = makeFindExpertise({ directoryRepo, employeeRepo: noEmployees });

    const out = (await tool.execute!({ skill: 'backend' } as never, {} as never)) as {
      found: boolean;
      people: string[];
    };

    expect(out.found).toBe(true);
    expect(out.people).toHaveLength(1);
    expect(out.people[0]).toContain('Pamela KONE');
    expect(out.people[0]).toContain('Backend Developer');
  });

  it('correspond par PRÉFIXE de mot, jamais par sous-chaîne', async () => {
    // Même règle que `findPersonByName`, et pour la même raison : « rao » ne doit pas
    // retrouver « Traoré ». Ici « api » ne doit pas retrouver « rapide ».
    const directoryRepo = await directoryWith([
      member({ slackUserId: 'U1', realName: 'A B', title: 'Prototypage rapide' }),
      member({ slackUserId: 'U2', realName: 'C D', title: 'API Platform' }),
    ]);
    const tool = makeFindExpertise({ directoryRepo, employeeRepo: noEmployees });

    const out = (await tool.execute!({ skill: 'api' } as never, {} as never)) as {
      people: string[];
    };

    expect(out.people).toHaveLength(1);
    expect(out.people[0]).toContain('C D');
  });

  it('ignore les accents et la casse', async () => {
    const directoryRepo = await directoryWith([
      member({ slackUserId: 'U1', realName: 'E F', title: 'Ingénierie Données' }),
    ]);
    const tool = makeFindExpertise({ directoryRepo, employeeRepo: noEmployees });

    const out = (await tool.execute!({ skill: 'DONNEES' } as never, {} as never)) as {
      found: boolean;
    };

    expect(out.found).toBe(true);
  });

  it('cherche AUSSI dans employees.position — Awa n est pas dans l annuaire', async () => {
    // Relevé de production : `employees` = 2 lignes, et Awa n'a AUCUNE ligne d'annuaire.
    // Une seule source laisserait la moitié du workspace introuvable, exactement comme pour
    // `findPersonByName`.
    const employeeRepo = {
      findAll: vi.fn().mockResolvedValue([
        {
          id: 'd36b78dc',
          firstName: 'Awa',
          lastName: 'TRAORE',
          position: 'Backend Developer',
          status: 'pending',
        },
      ]),
    } as never;
    const tool = makeFindExpertise({ directoryRepo: await directoryWith([]), employeeRepo });

    const out = (await tool.execute!({ skill: 'backend' } as never, {} as never)) as {
      found: boolean;
      people: string[];
    };

    expect(out.found).toBe(true);
    expect(out.people[0]).toContain('Awa TRAORE');
  });

  it('ne rend JAMAIS deux fois la même personne', async () => {
    // Une personne présente dans les deux sources est UNE personne. Le doublon ferait croire
    // à deux collègues compétents là où il n'y en a qu'un.
    const directoryRepo = await directoryWith([
      member({ slackUserId: 'U1', realName: 'Awa TRAORE', title: 'Backend Developer' }),
    ]);
    const employeeRepo = {
      findAll: vi
        .fn()
        .mockResolvedValue([
          { id: 'x', firstName: 'Awa', lastName: 'TRAORE', position: 'Backend Developer' },
        ]),
    } as never;
    const tool = makeFindExpertise({ directoryRepo, employeeRepo });

    const out = (await tool.execute!({ skill: 'backend' } as never, {} as never)) as {
      people: string[];
    };

    expect(out.people).toHaveLength(1);
  });

  it('écarte les bots et les comptes désactivés', async () => {
    const directoryRepo = await directoryWith([
      member({ slackUserId: 'U1', realName: 'Botty', title: 'Backend Bot', isBot: true }),
      member({ slackUserId: 'U2', realName: 'Parti', title: 'Backend Dev', isDeleted: true }),
    ]);
    const tool = makeFindExpertise({ directoryRepo, employeeRepo: noEmployees });

    const out = (await tool.execute!({ skill: 'backend' } as never, {} as never)) as {
      found: boolean;
      reason?: string;
    };

    expect(out.found).toBe(false);
    expect(out.reason).toBe('no_match');
  });

  it('ne rend AUCUN identifiant ni AUCUNE adresse', async () => {
    // Discipline de `findPersonByName`, et elle vaut davantage ici : la question est POSÉE au
    // pluriel, donc une réponse portant des UUID inviterait le modèle à en choisir un — le
    // geste exact qui a envoyé le document d'Awa à l'adresse de Karyl.
    const directoryRepo = await directoryWith([
      member({
        slackUserId: 'U0SECRET',
        realName: 'Pamela KONE',
        email: 'pamela@kisso.com',
        title: 'Backend Developer',
      }),
    ]);
    const tool = makeFindExpertise({ directoryRepo, employeeRepo: noEmployees });

    const out = await tool.execute!({ skill: 'backend' } as never, {} as never);
    const serialized = JSON.stringify(out);

    expect(serialized).not.toContain('U0SECRET');
    expect(serialized).not.toContain('pamela@kisso.com');
  });

  it('BORNE la liste et le signale', async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      member({ slackUserId: `U${i}`, realName: `Personne ${i}`, title: 'Backend Developer' }),
    );
    const tool = makeFindExpertise({
      directoryRepo: await directoryWith(many),
      employeeRepo: noEmployees,
    });

    const out = (await tool.execute!({ skill: 'backend' } as never, {} as never)) as {
      people: string[];
      truncated: boolean;
    };

    expect(out.people.length).toBeLessThanOrEqual(8);
    expect(out.truncated).toBe(true);
  });

  it('rend found:false et INSTRUIT quand personne ne correspond', async () => {
    const tool = makeFindExpertise({
      directoryRepo: await directoryWith([
        member({ slackUserId: 'U1', realName: 'A B', title: 'Designer' }),
      ]),
      employeeRepo: noEmployees,
    });

    const out = (await tool.execute!({ skill: 'kubernetes' } as never, {} as never)) as {
      found: boolean;
      reason: string;
      hint: string;
    };

    expect(out.found).toBe(false);
    expect(out.reason).toBe('no_match');
    // Le vide doit se distinguer de l'échec, et instruire — sinon le modèle comble.
    expect(out.hint).toMatch(/invente|déclaré/i);
  });

  it('ne LÈVE jamais si une source est en panne', async () => {
    // Discipline commune à tous les tools de résolution du dépôt : dégrader, jamais échouer.
    const employeeRepo = { findAll: vi.fn().mockRejectedValue(new Error('turso down')) } as never;
    const directoryRepo = await directoryWith([
      member({ slackUserId: 'U1', realName: 'Pamela KONE', title: 'Backend Developer' }),
    ]);
    const tool = makeFindExpertise({ directoryRepo, employeeRepo });

    const out = (await tool.execute!({ skill: 'backend' } as never, {} as never)) as {
      found: boolean;
    };

    expect(out.found).toBe(true);
  });

  it('tient sous 120 tokens même sur une liste pleine', async () => {
    // Le tool-result est réémis à CHAQUE aller-retour suivant : sa taille ne doit pas dépendre
    // de la taille du workspace. Contrainte de `tool-result-budget.test.ts`.
    const many = Array.from({ length: 40 }, (_, i) =>
      member({
        slackUserId: `U${i}`,
        realName: `Prénom${i} NOMDEFAMILLE${i}`,
        title: 'Backend Developer Senior Platform',
      }),
    );
    const tool = makeFindExpertise({
      directoryRepo: await directoryWith(many),
      employeeRepo: noEmployees,
    });

    const out = await tool.execute!({ skill: 'backend' } as never, {} as never);

    expect(Math.round(JSON.stringify(out).length / 3.5)).toBeLessThan(120);
  });
});

/**
 * ════════════════════════════════════════════════════════════════════════════
 * L'ENTRETIEN EST UNE MATIÈRE DE RECHERCHE — 2026-08-19
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Défaut mesuré en production ce jour-là : à « qui s'occupe du support technique ? », l'outil
 * a rendu « aucun collaborateur n'est identifié » alors que la personne venait d'écrire, dans
 * son entretien, qu'elle fait du support technique. La réponse était HONNÊTE — la donnée était
 * ailleurs — mais l'entretien est le seul endroit du produit où quelqu'un décrit son métier
 * avec ses mots, ce qui est exactement ce qu'une recherche d'expertise cherche. `position` est
 * un intitulé RH saisi une fois à la création du dossier.
 */
describe('findExpertise — ce que la personne dit faire, pas seulement son intitulé', () => {
  const KARYL = 'd20df236-5c24-42a5-b205-d0d738d34fb4';

  const employeesOnly = {
    findAll: async () => [
      { id: KARYL, firstName: 'Karyl', lastName: 'SOUMAILA', position: 'Developer' },
    ],
  } as never;

  const emptyDirectory = {
    listAll: async () => [],
  } as never;

  const interviews = {
    listAll: async () => [
      {
        employeeId: KARYL,
        slackUserId: 'U0BJBDGTJUD',
        channels: [],
        dailyWork: 'je fais du support technique et je suis les tickets de bout en bout',
        workStyle: '',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  } as never;

  it('retrouve quelqu’un par ce qu’il a écrit dans son entretien', async () => {
    const tool = makeFindExpertise({
      directoryRepo: emptyDirectory,
      employeeRepo: employeesOnly,
      interviewRepo: interviews,
    });

    const out = (await tool.execute!({ skill: 'support technique' } as never, {} as never)) as {
      found: boolean;
      people: string[];
    };

    expect(out.found).toBe(true);
    expect(out.people[0]).toContain('Karyl');
  });

  it('préfère le POSTE quand c’est lui qui correspond', async () => {
    // L'intitulé officiel reste ce qu'on montre en premier : l'entretien n'apporte de la
    // matière que là où le poste n'en donne pas.
    const tool = makeFindExpertise({
      directoryRepo: emptyDirectory,
      employeeRepo: employeesOnly,
      interviewRepo: interviews,
    });

    const out = (await tool.execute!({ skill: 'developer' } as never, {} as never)) as {
      people: string[];
    };

    expect(out.people[0]).toContain('Developer');
  });

  it('sans dépôt d’entretiens, se comporte EXACTEMENT comme avant', async () => {
    // La dépendance est optionnelle : son absence est une configuration, jamais un incident.
    // La compter comme une source en panne rendrait « recherche incomplète » une réponse
    // parfaitement complète.
    const tool = makeFindExpertise({
      directoryRepo: emptyDirectory,
      employeeRepo: employeesOnly,
    });

    const out = (await tool.execute!({ skill: 'support technique' } as never, {} as never)) as {
      found: boolean;
      reason: string;
    };

    expect(out.found).toBe(false);
    expect(out.reason).toBe('no_match');
  });

  it('un dépôt d’entretiens EN PANNE ne dégrade pas le verdict', async () => {
    const broken = {
      listAll: async () => {
        throw new Error('no such table: onboarding_interview');
      },
    } as never;

    const tool = makeFindExpertise({
      directoryRepo: emptyDirectory,
      employeeRepo: employeesOnly,
      interviewRepo: broken,
    });

    const out = (await tool.execute!({ skill: 'developer' } as never, {} as never)) as {
      found: boolean;
    };

    // La source principale a répondu : le résultat reste un vrai résultat.
    expect(out.found).toBe(true);
  });
});

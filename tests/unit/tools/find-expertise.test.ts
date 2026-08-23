import { describe, it, expect, vi } from 'vitest';

import { makeFindExpertise } from '../../../src/features/knowledge/application/tools/find-expertise';
import { InMemoryDirectoryRepository } from '../../../src/features/directory/infrastructure/repositories/in-memory-directory.repository';

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
    findAll: async () => [],
  } as never;

  const interviews = {
    findAll: async () => [
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
      findAll: async () => {
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

/**
 * ════════════════════════════════════════════════════════════════════════════
 * Le seul FAUX RÉSULTAT SILENCIEUX du lot d'outils — 2026-08-19
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `experts.slice(0, 6)` sans AUCUN `sort()` : les six retenus étaient ceux dont l'identifiant
 * technique triait le plus bas — `slack_user_id` pour l'annuaire, un UUID pour les dossiers.
 * Arbitraire, mais STABLE : ce n'étaient pas six personnes au hasard, c'étaient TOUJOURS LES
 * SIX MÊMES. Passé un certain effectif, une partie de l'entreprise devenait définitivement
 * invisible à « qui s'occupe de X ? », sans que rien ne le signale.
 *
 * Et `truncated: true` était un CHAMP SÉPARÉ — c'est-à-dire précisément la forme dont ce dépôt
 * a MESURÉ le 2026-08-14 qu'elle est ignorée par le modèle : sur `getChannelHistory`, un champ
 * nommé `coverage` a été purement ignoré, le même texte renommé `hint` aussi. La conclusion
 * écrite alors — « un champ séparé se lit comme une métadonnée, quel que soit son nom » — n'a
 * jamais été appliquée ici.
 *
 * ⚠️ Portée honnête : à six personnes dans le workspace, rien de tout cela ne se voit
 * aujourd'hui. C'est un défaut LATENT, qui s'ouvre dès SEPT personnes correspondant à un même
 * terme — immédiat pour « engineering » ou « produit » dans un workspace de 40.
 */
describe('findExpertise — l’ordre et la couverture', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      member({
        slackUserId: `U${String(i).padStart(2, '0')}`,
        realName: `Personne ${i}`,
        title: 'Backend Developer',
      }),
    );

  it('ANNONCE la coupe dans le contenu, pas dans un champ à côté', async () => {
    const directoryRepo = await directoryWith(many(12));
    const tool = makeFindExpertise({ directoryRepo, employeeRepo: noEmployees });

    const out = (await tool.execute!({ skill: 'backend' } as never, {} as never)) as {
      people: string[];
      truncated: boolean;
    };

    expect(out.truncated).toBe(true);
    // La phrase est DANS la liste que le modèle lit, en tête. Un champ séparé serait sauté.
    expect(out.people[0]).toMatch(/12/);
    expect(out.people[0]).not.toMatch(/—/);
  });

  it('ne dit RIEN quand tout a été montré — on ne paie que ce qui est utile', async () => {
    const directoryRepo = await directoryWith(many(3));
    const tool = makeFindExpertise({ directoryRepo, employeeRepo: noEmployees });

    const out = (await tool.execute!({ skill: 'backend' } as never, {} as never)) as {
      people: string[];
      truncated: boolean;
    };

    expect(out.truncated).toBe(false);
    expect(out.people).toHaveLength(3);
    expect(out.people[0]).toContain('—');
  });

  it('classe le POSTE DÉCLARÉ avant un simple indice d’entretien', async () => {
    // Sans classement, c'est l'ordre des identifiants techniques qui décidait qui survit à la
    // coupe. Le poste officiel est le signal le plus fort ; l'entretien vient après.
    const directoryRepo = await directoryWith([]);
    const employeeRepo = {
      findAll: vi.fn().mockResolvedValue([
        { id: 'aaa', firstName: 'Par', lastName: 'Entretien', position: 'Designer' },
        { id: 'zzz', firstName: 'Par', lastName: 'Poste', position: 'Backend Developer' },
      ]),
    } as never;
    const interviewRepo = {
      findAll: vi.fn().mockResolvedValue([{ employeeId: 'aaa', dailyWork: 'je fais du backend' }]),
    } as never;

    const tool = makeFindExpertise({ directoryRepo, employeeRepo, interviewRepo });
    const out = (await tool.execute!({ skill: 'backend' } as never, {} as never)) as {
      people: string[];
    };

    // `aaa` trie avant `zzz` : sans classement, « Par Entretien » passait en premier.
    expect(out.people[0]).toContain('Par Poste');
  });
});

describe('findExpertise — deux personnes, un même nom', () => {
  it('ne les FUSIONNE plus quand elles viennent de la même source', async () => {
    // La déduplication portait sur le NOM normalisé. Elle existe pour un vrai besoin — une
    // personne présente à la fois dans `employees` et dans l'annuaire — mais elle ne savait pas
    // distinguer « une personne, deux sources » de « deux personnes, un nom ». Le second
    // homonyme disparaissait sans trace.
    //
    // ⚠️ `findPersonByName` traite le même problème CORRECTEMENT : sur ambiguïté il rend
    // `reason: 'ambiguous'` et aucun identifiant. La règle avait été comprise et appliquée à un
    // outil, pas à son voisin.
    const directoryRepo = await directoryWith([
      member({ slackUserId: 'U1', realName: 'Jean Martin', title: 'Backend Developer' }),
      member({ slackUserId: 'U2', realName: 'Jean Martin', title: 'Backend Developer' }),
    ]);
    const tool = makeFindExpertise({ directoryRepo, employeeRepo: noEmployees });

    const out = (await tool.execute!({ skill: 'backend' } as never, {} as never)) as {
      people: string[];
    };

    expect(out.people).toHaveLength(2);
  });

  it('FUSIONNE toujours la même personne vue par deux sources', async () => {
    // Le besoin d'origine, qui ne doit pas régresser.
    const directoryRepo = await directoryWith([
      member({ slackUserId: 'U1', realName: 'Awa TRAORE', title: 'Backend Developer' }),
    ]);
    const employeeRepo = {
      findAll: vi
        .fn()
        .mockResolvedValue([
          { id: 'e1', firstName: 'Awa', lastName: 'TRAORE', position: 'Backend Developer' },
        ]),
    } as never;

    const tool = makeFindExpertise({ directoryRepo, employeeRepo });
    const out = (await tool.execute!({ skill: 'backend' } as never, {} as never)) as {
      people: string[];
    };

    expect(out.people).toHaveLength(1);
  });
});

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LA SOURCE PRIVÉE EST DERRIÈRE LA FRONTIÈRE — correctif du 2026-08-22
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `findExpertise` était le seul outil du dépôt touchant des données de personnes SANS
 * consulter la moindre garde — sa signature `execute: async ({ skill }) =>` ne déclarait
 * même pas de second paramètre, si bien que le `requestContext` n'existait pas dans sa
 * portée : la garde n'était pas oubliée, elle était structurellement inatteignable.
 *
 * ⚠️ CE QUI FUYAIT N'ÉTAIT PAS LE TEXTE, C'ÉTAIT UN ORACLE. Le tool ne cite jamais un mot
 * de l'entretien — il rend « X — d'après ce qu'iel a décrit de son travail au quotidien ».
 * Mais `matchesName` compare par PRÉFIXE et le schéma accepte deux caractères : en variant
 * « ps », « po », « pos »… on reconstruit, mot par mot et ATTRIBUÉ À UN NOM, le vocabulaire
 * du texte que quelqu'un a écrit sur lui-même. Un bit par requête suffit à tout lire.
 *
 * ⚠️ LA FRONTIÈRE NE FERME PAS L'OUTIL, elle ferme la SOURCE PRIVÉE. Les postes déclarés
 * (`slack_directory.title`, `employees.position`) restent interrogeables par tout le monde :
 * ils sont déjà visibles dans le profil Slack de chacun, et « qui s'occupe du backend ? »
 * doit continuer de marcher pour un salarié ordinaire — c'est la raison d'être du tool, et
 * la réponse alternative est celle que le modèle inventerait.
 *
 * ⚠️ LES DEUX MOITIÉS SONT TESTÉES. Un refus généralisé est indiscernable d'une frontière
 * qui fonctionne : sans le second test, une panne qui vide `dailyWork` pour tout le monde
 * passerait pour de la sécurité.
 */
describe('findExpertise — l’entretien est une source privée', () => {
  const KARYL_ID = '11111111-1111-4111-8111-111111111111';

  const soloEmployee = {
    findAll: async () => [
      { id: KARYL_ID, firstName: 'Karyl', lastName: 'SOUMAILA', position: 'Developer' },
    ],
  } as never;

  const emptyDirectory = { findAll: async () => [] } as never;

  const interviewRepo = {
    findAll: async () => [
      { employeeId: KARYL_ID, dailyWork: 'je fais du support technique sur les tickets' },
    ],
  } as never;

  function slackContext(accessLevel: 'readonly' | 'full') {
    return {
      requestContext: new Map<string, unknown>([
        ['slackChannel', 'D0PRIVE01'],
        ['slackUserId', 'U0AUTRE00'],
        ['slackAccessLevel', accessLevel],
      ]),
    } as never;
  }

  async function search(accessLevel: 'readonly' | 'full') {
    const tool = makeFindExpertise({
      directoryRepo: emptyDirectory,
      employeeRepo: soloEmployee,
      interviewRepo,
    });
    return (await tool.execute!({ skill: 'support' } as never, slackContext(accessLevel))) as {
      found: boolean;
      people?: string[];
    };
  }

  it('ne consulte PAS l’entretien pour un demandeur ordinaire — l’oracle est fermé', async () => {
    const result = await search('readonly');

    expect(result.found).toBe(false);
  });

  it('le consulte pour le manager — la frontière filtre, elle n’éteint pas', async () => {
    const result = await search('full');

    expect(result.found).toBe(true);
    expect(result.people?.join(' ')).toContain('Karyl');
  });

  it('le poste déclaré, lui, reste interrogeable par tout le monde', async () => {
    const tool = makeFindExpertise({
      directoryRepo: emptyDirectory,
      employeeRepo: soloEmployee,
      interviewRepo,
    });

    const result = (await tool.execute!(
      { skill: 'developer' } as never,
      slackContext('readonly'),
    )) as { found: boolean };

    expect(result.found).toBe(true);
  });
});

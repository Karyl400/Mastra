import { describe, it, expect } from 'vitest';
import { makeFindEmployeeByEmail } from '../../../src/features/employee/application/tools/find-employee-by-email';
import { InMemoryEmployeeRepository } from '../../../src/features/employee/infrastructure/repositories/in-memory-employee.repository';
import { createEmployee } from '../../../src/features/employee/domain/entities/employee';

async function seedKaryl(repo: InMemoryEmployeeRepository) {
  const employee = createEmployee({
    id: 'emp-karyl-uuid',
    firstName: 'Karyl',
    lastName: 'Soumaila',
    email: 'karyl.soumaila@kisso.com',
    department: 'Engineering',
    position: 'Backend Developer',
    startDate: new Date().toISOString(),
    managerId: null,
  });
  await repo.save(employee);
  return employee;
}

describe('Tool: findEmployeeByEmail', () => {
  it('finds an employee by exact email match', async () => {
    const repo = new InMemoryEmployeeRepository();
    await seedKaryl(repo);
    const tool = makeFindEmployeeByEmail(repo);

    const result = (await tool.execute!(
      { email: 'karyl.soumaila@kisso.com' } as never,
      {} as never,
    )) as Record<string, unknown>;

    expect(result.found).toBe(true);
    const employee = result.employee as Record<string, unknown>;
    expect(employee.id).toBe('emp-karyl-uuid');
    expect(employee.firstName).toBe('Karyl');
    expect(employee.lastName).toBe('Soumaila');
    expect(employee.status).toBeDefined();
  });

  it('is case-insensitive', async () => {
    const repo = new InMemoryEmployeeRepository();
    await seedKaryl(repo);
    const tool = makeFindEmployeeByEmail(repo);

    const result = (await tool.execute!(
      { email: 'KARYL.SOUMAILA@KISSO.COM' } as never,
      {} as never,
    )) as Record<string, unknown>;

    expect(result.found).toBe(true);
    expect((result.employee as Record<string, unknown>).id).toBe('emp-karyl-uuid');
  });

  it('trims stray whitespace around the email', async () => {
    const repo = new InMemoryEmployeeRepository();
    await seedKaryl(repo);
    const tool = makeFindEmployeeByEmail(repo);

    const result = (await tool.execute!(
      { email: '  karyl.soumaila@kisso.com  ' } as never,
      {} as never,
    )) as Record<string, unknown>;

    expect(result.found).toBe(true);
    expect((result.employee as Record<string, unknown>).id).toBe('emp-karyl-uuid');
  });

  it('returns a not-found result (not an exception) for an unknown email', async () => {
    const repo = new InMemoryEmployeeRepository();
    const tool = makeFindEmployeeByEmail(repo);

    const result = (await tool.execute!(
      { email: 'unknown@kisso.com' } as never,
      {} as never,
    )) as Record<string, unknown>;

    expect(result.found).toBe(false);
    expect(result.employee).toBeUndefined();
  });

  /**
   * Incident du 2026-08-11 à 2:56 : l'utilisateur avait donné son email une
   * minute plus tôt ; privé de mémoire conversationnelle, l'agent a répondu
   * « Je ne trouve pas d'employé avec l'email votre_email@example.com ».
   *
   * `emailSchema` ne pouvait rien y voir — la valeur inventée est syntaxiquement
   * parfaite. Le modèle fabrique une entrée VALIDE pour que l'appel passe.
   */
  describe('emails de remplissage inventés par le modèle', () => {
    const call = async (email: string) => {
      const repo = new InMemoryEmployeeRepository();
      await seedKaryl(repo);
      const tool = makeFindEmployeeByEmail(repo);
      return (await tool.execute!({ email } as never, {} as never)) as Record<string, unknown>;
    };

    it.each([
      'votre_email@example.com',
      'votre.email@kisso.com',
      'your_email@example.org',
      'email@example.net',
      'user@example.com',
      'nom.prenom@kisso.com',
      'prenom.nom@kisso.com',
      'exemple@kisso.com',
      'test@kisso.com',
      'john.doe@kisso.com',
      'placeholder@kisso.com',
      'karyl@example.com',
      'karyl@kisso.test',
      'karyl@kisso.invalid',
    ])('rejette %s', async (email) => {
      const result = await call(email);

      expect(result.found).toBe(false);
      expect(result.reason).toBe('placeholder_email');
      expect(result.employee).toBeUndefined();
    });

    it('laisse `emailSchema` intercepter en amont ce qui n’est pas une adresse', async () => {
      // `karyl@localhost` n'atteint JAMAIS `execute` : `createTool` valide
      // l'`inputSchema` même sur un appel direct, et `.email()` refuse un domaine
      // sans TLD. Le refus arrive donc plus tôt et sous une autre forme — d'où
      // l'absence de `localhost` dans la liste ci-dessus, alors qu'il figure bien
      // dans `RESERVED_DOMAINS` (défense en profondeur).
      const result = await call('karyl@localhost');

      expect(result.error).toBe(true);
      expect(String(result.message)).toContain('validation failed');
      expect(result.found).toBeUndefined();
    });

    it("instruit le modèle plutôt que d'échouer sèchement", async () => {
      // Un simple `found: false` inviterait le modèle à retenter avec une autre
      // adresse inventée. Le résultat doit lui dire quoi faire.
      const result = await call('votre_email@example.com');

      expect(String(result.hint)).toMatch(/n'invente|demande/i);
      expect(String(result.hint)).toMatch(/professionnel/i);
    });

    it("n'a pas touché la base — le refus précède toute E/S", async () => {
      const repo = new InMemoryEmployeeRepository();
      await seedKaryl(repo);
      let lookups = 0;
      const original = repo.findByEmail.bind(repo);
      repo.findByEmail = async (email: string) => {
        lookups += 1;
        return original(email);
      };
      const tool = makeFindEmployeeByEmail(repo);

      await tool.execute!({ email: 'votre_email@example.com' } as never, {} as never);

      expect(lookups).toBe(0);
    });

    it("ne rejette PAS l'email réel de l'incident", async () => {
      // Garde-fou anti-faux-positif : le coût d'un faux positif est un employé
      // réel déclaré introuvable.
      const result = await call('karylsoumaila1@gmail.com');

      expect(result.reason).toBeUndefined();
      expect(result.found).toBe(false); // absent de la base, mais pour la BONNE raison
    });

    it.each([
      'karyl.soumaila@kisso.com',
      'karylsoumaila1@gmail.com',
      'jean-testu@kisso.com',
      'remaild@kisso.com',
      'usernotreally@kisso.com',
      'unknown@kisso.com',
    ])('laisse passer %s', async (email) => {
      const result = await call(email);

      expect(result.reason).toBeUndefined();
    });
  });

  it('never exposes salary, emergency contact, phone or metadata', async () => {
    const repo = new InMemoryEmployeeRepository();
    await seedKaryl(repo);
    const tool = makeFindEmployeeByEmail(repo);

    const result = (await tool.execute!(
      { email: 'karyl.soumaila@kisso.com' } as never,
      {} as never,
    )) as Record<string, unknown>;

    const employee = result.employee as Record<string, unknown>;
    const exposedKeys = Object.keys(employee);
    expect(exposedKeys).not.toContain('salaryAmount');
    expect(exposedKeys).not.toContain('salaryCurrency');
    expect(exposedKeys).not.toContain('emergencyContactName');
    expect(exposedKeys).not.toContain('emergencyContactPhone');
    expect(exposedKeys).not.toContain('phone');
    expect(exposedKeys).not.toContain('metadata');
    expect(exposedKeys).not.toContain('email');
  });
});

/**
 * Repli sur l'annuaire Slack.
 *
 * Panne reproduite : le 2026-08-12 en production, `mistourath@kissohq.com` et
 * `ridwanenico77@gmail.com` ont été déclarés introuvables alors que les deux
 * personnes figuraient dans `slack_directory` avec prénom, nom et poste. Seule
 * `employees` était interrogée, et elle ne contenait qu'une ligne vivante.
 */
function directoryStub(members: Array<Partial<Record<string, unknown>>>) {
  return {
    findByEmail: async (email: string) =>
      (members.find((m) => String(m.email).toLowerCase() === email.toLowerCase()) as never) ?? null,
    findBySlackUserId: async () => null,
    upsertFacts: async () => {},
    listAll: async () => [],
  } as never;
}

const MISTOURATH = {
  slackUserId: 'U0A1N067JGL',
  email: 'mistourath@kissohq.com',
  firstName: 'Mistourath',
  lastName: 'IDI',
  title: 'Product Designer',
  isBot: false,
  isDeleted: false,
  employeeId: null,
};

describe('Tool: findEmployeeByEmail — repli sur l’annuaire Slack', () => {
  it("résout une personne absente d'`employees` mais présente dans l'annuaire", async () => {
    const tool = makeFindEmployeeByEmail(
      new InMemoryEmployeeRepository(),
      directoryStub([MISTOURATH]),
    );

    const result = (await tool.execute!(
      { email: 'mistourath@kissohq.com' } as never,
      {} as never,
    )) as Record<string, unknown>;

    expect(result.found).toBe(true);
    expect(result.source).toBe('slack_directory');
    const person = result.person as Record<string, unknown>;
    expect(person.slackUserId).toBe('U0A1N067JGL');
    expect(person.firstName).toBe('Mistourath');
    expect(person.title).toBe('Product Designer');
  });

  it("n'expose PAS d'identifiant interne quand la personne n'a pas de dossier, et le dit", async () => {
    // Sans cela, le modèle prendrait le `U…` pour l'UUID attendu par
    // getEmployeeProfile / getTaskList, ou en inventerait un.
    const tool = makeFindEmployeeByEmail(
      new InMemoryEmployeeRepository(),
      directoryStub([MISTOURATH]),
    );

    const result = (await tool.execute!(
      { email: 'mistourath@kissohq.com' } as never,
      {} as never,
    )) as Record<string, unknown>;

    expect(result.employee).toBeUndefined();
    expect((result.person as Record<string, unknown>).employeeId).toBeNull();
    expect(String(result.hint)).toContain("aucun dossier d'onboarding");
  });

  it('`employees` reste PRIORITAIRE — sinon on perdrait l’UUID interne', async () => {
    const repo = new InMemoryEmployeeRepository();
    await seedKaryl(repo);
    const tool = makeFindEmployeeByEmail(
      repo,
      directoryStub([{ ...MISTOURATH, email: 'karyl.soumaila@kisso.com' }]),
    );

    const result = (await tool.execute!(
      { email: 'karyl.soumaila@kisso.com' } as never,
      {} as never,
    )) as Record<string, unknown>;

    expect(result.source).toBe('employees');
    expect((result.employee as Record<string, unknown>).id).toBe('emp-karyl-uuid');
  });

  it('écarte bots et comptes désactivés', async () => {
    const tool = makeFindEmployeeByEmail(
      new InMemoryEmployeeRepository(),
      directoryStub([
        { ...MISTOURATH, email: 'bot@kissohq.com', isBot: true },
        { ...MISTOURATH, email: 'parti@kissohq.com', isDeleted: true },
      ]),
    );

    for (const email of ['bot@kissohq.com', 'parti@kissohq.com']) {
      const result = (await tool.execute!({ email } as never, {} as never)) as Record<
        string,
        unknown
      >;
      expect(result.found, email).toBe(false);
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  // ÉCHEC QUI INSTRUIT — relevé de production, deux jours de suite
  // ════════════════════════════════════════════════════════════════════════
  //     Karyl  : « Bonjour, que peux-tu faire pour moi ? »
  //     Mastra : « Je n'ai pas trouvé d'employé avec l'adresse
  //               karyl.soumaila@kisso.com. […] Tu peux me les donner ? »
  //
  // Le modèle a FABRIQUÉ une adresse plausible à partir du nom de la personne —
  // `isPlaceholderEmail` ne peut rien contre elle — puis a réclamé à l'humain une
  // information que le système DÉTENAIT DÉJÀ. Un tour de dialogue perdu est le poste de
  // coût le plus cher du produit, sur un budget de ≈ 19 messages/JOUR.
  describe('quand la recherche échoue', () => {
    const contextDe = (employeeId: string) => ({
      requestContext: new Map<string, unknown>([
        ['slackChannel', 'D0MOCKDM01'],
        ['slackUserId', 'U000HUMAN01'],
        ['slackEmployeeId', employeeId],
      ]),
    });

    it("rappelle l'identifiant du DEMANDEUR plutôt que de lui redemander son email", async () => {
      const tool = makeFindEmployeeByEmail(new InMemoryEmployeeRepository());

      const result = (await tool.execute!(
        { email: 'karyl.soumaila@kisso.com' } as never,
        contextDe('emp-karyl-uuid') as never,
      )) as Record<string, unknown>;

      expect(result.found).toBe(false);
      expect(result.hint).toContain('emp-karyl-uuid');
      // Il doit AUSSI couper la boucle du modèle qui retente en modifiant l'adresse.
      expect(String(result.hint)).toMatch(/ne la reessaie pas|ne la réessaie pas/i);
    });

    it("ne dit rien de plus hors Slack, où aucun demandeur n'est connu", async () => {
      // Playground, route HTTP, workflow, test : `readSlackContext` rend `undefined`, et
      // c'est le cas NORMAL de ces chemins. On ne fabrique pas un indice sans demandeur.
      const tool = makeFindEmployeeByEmail(new InMemoryEmployeeRepository());

      const result = (await tool.execute!(
        { email: 'inconnu@kissohq.com' } as never,
        {} as never,
      )) as Record<string, unknown>;

      expect(result.found).toBe(false);
      expect(result.hint).toBeUndefined();
    });
  });

  it("sans annuaire injecté, le comportement d'origine est inchangé", async () => {
    const tool = makeFindEmployeeByEmail(new InMemoryEmployeeRepository());

    const result = (await tool.execute!(
      { email: 'mistourath@kissohq.com' } as never,
      {} as never,
    )) as Record<string, unknown>;

    expect(result.found).toBe(false);
  });
});

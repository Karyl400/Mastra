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

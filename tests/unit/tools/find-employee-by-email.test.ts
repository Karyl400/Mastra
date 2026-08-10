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

import { describe, it, expect, vi } from 'vitest';
import { makeCreateEmployee } from '../../../src/features/employee/application/tools/create-employee';
import type { EmployeeRepository } from '../../../src/features/employee/domain/ports/employee.repository';
import { ConflictError } from '../../../src/shared/errors';

const baseInput = {
  firstName: 'Jean',
  lastName: 'Dupont',
  email: 'jean.dupont@kisso.com',
  department: 'Engineering',
  position: 'Backend Developer',
  startDate: new Date().toISOString(),
};

function makeMockRepo(overrides: Partial<EmployeeRepository> = {}): EmployeeRepository {
  return {
    findById: vi.fn().mockResolvedValue(null),
    findByEmail: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    findAll: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe('Tool: createEmployee', () => {
  it('creates an employee and returns a DTO when input is valid', async () => {
    const repo = makeMockRepo();
    const tool = makeCreateEmployee(repo);

    const result = await tool.execute!(baseInput as never, {} as never) as Record<string, unknown>;

    expect(result).toBeDefined();
    expect((result as { employee?: { firstName: string } }).employee?.firstName).toBe('Jean');
    expect(repo.findByEmail).toHaveBeenCalledWith(baseInput.email);
    expect(repo.save).toHaveBeenCalled();
  });

  it('throws ConflictError when email already exists', async () => {
    const repo = makeMockRepo({
      findByEmail: vi.fn().mockResolvedValue({ id: 'emp-existing' }),
    });
    const tool = makeCreateEmployee(repo);

    await expect(tool.execute!(baseInput as never, {} as never)).rejects.toBeInstanceOf(ConflictError);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('stores idempotencyKey result on second call', async () => {
    const repo = makeMockRepo();
    const tool = makeCreateEmployee(repo);
    const idempotencyKey = crypto.randomUUID();
    const input = { ...baseInput, idempotencyKey };

    const first = await tool.execute!(input as never, {} as never);
    const second = await tool.execute!(input as never, {} as never);

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    // repo.save should only have been called once due to idempotency cache
    expect(repo.save).toHaveBeenCalledTimes(1);
  });
});

describe('UseCase: CreateEmployeeUseCase', () => {
  it('throws ConflictError when email is already taken', async () => {
    const { CreateEmployeeUseCase } = await import(
      '../../../src/features/employee/application/tools/create-employee'
    );
    const repo = makeMockRepo({
      findByEmail: vi.fn().mockResolvedValue({ id: 'emp-existing' }),
    });
    const useCase = new CreateEmployeeUseCase(repo);

    await expect(useCase.execute(baseInput)).rejects.toBeInstanceOf(ConflictError);
  });

  it('saves exactly one employee on success', async () => {
    const { CreateEmployeeUseCase } = await import(
      '../../../src/features/employee/application/tools/create-employee'
    );
    const repo = makeMockRepo();
    const useCase = new CreateEmployeeUseCase(repo);

    const result = await useCase.execute(baseInput);

    expect(result.employee.firstName).toBe('Jean');
    expect(result.employee.email).toBe(baseInput.email);
    expect(repo.save).toHaveBeenCalledTimes(1);
  });
});

describe('Sanitizer: EmployeeDataSanitizer', () => {
  it('strips HTML tags from department and position', async () => {
    const { EmployeeDataSanitizer } = await import(
      '../../../src/features/employee/application/tools/create-employee'
    );
    const { EmployeeStatus } = await import('../../../src/shared/types');

    const dirty = {
      firstName: 'John',
      lastName: 'Doe',
      email: 'john@kisso.com',
      department: '<script>alert(1)</script>Engineering',
      position: 'Backend Developer<img src="x">',
      startDate: new Date().toISOString(),
      managerId: null,
      options: { initialStatus: EmployeeStatus.Pending },
    };

    const clean = EmployeeDataSanitizer.sanitize(dirty as never);
    expect(clean.department).toBe('Engineering');
    expect(clean.position).not.toContain('<script>');
  });
});

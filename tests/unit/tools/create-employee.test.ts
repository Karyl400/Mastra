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
    findByName: vi.fn().mockResolvedValue([]),
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

    const result = (await tool.execute!(baseInput as never, {} as never)) as Record<
      string,
      unknown
    >;

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

    await expect(tool.execute!(baseInput as never, {} as never)).rejects.toBeInstanceOf(
      ConflictError,
    );
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
    const { CreateEmployeeUseCase } =
      await import('../../../src/features/employee/application/tools/create-employee');
    const repo = makeMockRepo({
      findByEmail: vi.fn().mockResolvedValue({ id: 'emp-existing' }),
    });
    const useCase = new CreateEmployeeUseCase(repo);

    await expect(useCase.execute(baseInput)).rejects.toBeInstanceOf(ConflictError);
  });

  it('saves exactly one employee on success', async () => {
    const { CreateEmployeeUseCase } =
      await import('../../../src/features/employee/application/tools/create-employee');
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
    const { EmployeeDataSanitizer } =
      await import('../../../src/features/employee/application/tools/create-employee');
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

/**
 * Ces tests verrouillent le comportement conservé lors de l'aplatissement du
 * JSON Schema de `department` / `position` (bug Groq `expected object, but got string`).
 * Aplatir le schéma ne doit RIEN retirer à la sanitization ni à la validation.
 *
 * NB : `tool.execute()` de Mastra n'exception PAS sur une erreur de schéma —
 * il retourne `{ error: true, message, validationErrors }` (message renvoyé au LLM).
 */
type ToolValidationError = {
  error?: boolean;
  message?: string;
  validationErrors?: { fields?: Record<string, { errors?: string[] }> };
};

function savedEmployee(repo: EmployeeRepository): Record<string, string> {
  const mock = (repo.save as unknown as { mock: { calls: Array<[Record<string, string>]> } }).mock;
  expect(mock.calls.length, 'repo.save was never called').toBeGreaterThan(0);
  return mock.calls[0][0];
}

describe('Tool: createEmployee — sanitization preserved after schema flattening', () => {
  it('still normalises names through sanitizeName (transform still runs)', async () => {
    const repo = makeMockRepo();
    const tool = makeCreateEmployee(repo);

    await tool.execute!(
      {
        ...baseInput,
        email: 'padded.name@kisso.com',
        firstName: '  Jean   Marie  ',
        lastName: "  O'Connor-Smith ",
      } as never,
      {} as never,
    );

    const saved = savedEmployee(repo);
    // sanitizeName : trim + collapse des espaces + strip HTML
    expect(saved.firstName).toBe('Jean Marie');
    expect(saved.lastName).toBe("O'Connor-Smith");
  });

  it('still REJECTS HTML injected in firstName (never reaches the repository)', async () => {
    const repo = makeMockRepo();
    const tool = makeCreateEmployee(repo);

    const result = (await tool.execute!(
      {
        ...baseInput,
        email: 'xss.attempt@kisso.com',
        firstName: 'Jean<script>alert(1)</script>',
      } as never,
      {} as never,
    )) as ToolValidationError;

    expect(result.error).toBe(true);
    expect(result.validationErrors?.fields?.firstName).toBeDefined();
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('still REJECTS a department carrying HTML instead of silently cleaning it', async () => {
    const repo = makeMockRepo();
    const tool = makeCreateEmployee(repo);

    const result = (await tool.execute!(
      {
        ...baseInput,
        email: 'dirty.dept@kisso.com',
        department: '<script>Engineering</script>',
      } as never,
      {} as never,
    )) as ToolValidationError;

    expect(result.error).toBe(true);
    expect(result.validationErrors?.fields?.department?.errors).toContain(
      'Department must be one of the allowed values',
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('ACCEPTS a job title absent from the enum — position is free text', async () => {
    // Le poste n'est plus une allowlist : « Software Engineer » ne figurait pas
    // dans l'enum, alors que c'est le titre le plus courant du métier.
    const repo = makeMockRepo();
    const tool = makeCreateEmployee(repo);

    const result = (await tool.execute!(
      { ...baseInput, email: 'free.position@kisso.com', position: 'Software Engineer' } as never,
      {} as never,
    )) as ToolValidationError;

    expect(result.error).toBeUndefined();
    expect(repo.save).toHaveBeenCalled();
  });

  it('still REJECTS a position carrying HTML', async () => {
    const repo = makeMockRepo();
    const tool = makeCreateEmployee(repo);

    const result = (await tool.execute!(
      { ...baseInput, email: 'bad.position@kisso.com', position: 'Dev <img src=x>' } as never,
      {} as never,
    )) as ToolValidationError;

    expect(result.error).toBe(true);
    expect(result.validationErrors?.fields?.position?.errors?.length).toBeGreaterThan(0);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('still trims whitespace around department / position (preprocess still runs)', async () => {
    const repo = makeMockRepo();
    const tool = makeCreateEmployee(repo);

    await tool.execute!(
      {
        ...baseInput,
        email: 'padded@kisso.com',
        department: '  Engineering  ',
        position: '\tBackend Developer\n',
      } as never,
      {} as never,
    );

    const saved = savedEmployee(repo);
    expect(saved.department).toBe('Engineering');
    expect(saved.position).toBe('Backend Developer');
  });

  it('accepts a plain-string department / position — the shape the LLM actually sends', async () => {
    const repo = makeMockRepo();
    const tool = makeCreateEmployee(repo);

    await tool.execute!(
      {
        ...baseInput,
        email: 'plain.string@kisso.com',
        department: 'Engineering',
        position: 'Backend Developer',
      } as never,
      {} as never,
    );

    const saved = savedEmployee(repo);
    expect(saved.department).toBe('Engineering');
    expect(saved.position).toBe('Backend Developer');
  });

  it('accepts an explicit null managerId even though the schema is flat', async () => {
    const repo = makeMockRepo();
    const tool = makeCreateEmployee(repo);

    const result = (await tool.execute!(
      { ...baseInput, email: 'null.manager@kisso.com', managerId: null } as never,
      {} as never,
    )) as { employee?: { id: string } };

    expect(result.employee?.id).toBeDefined();
    expect(repo.save).toHaveBeenCalledTimes(1);
  });
});

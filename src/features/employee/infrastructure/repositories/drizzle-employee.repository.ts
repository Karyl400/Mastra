import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { getDb, type DatabaseInstance } from '../../../../infrastructure/database/connection';
import { employees } from '../../../../infrastructure/database/schema';
import type { Employee } from '../../domain/entities/employee';
import type { EmployeeRepository } from '../../domain/ports/employee.repository';
import { EmployeeStatus } from '../../../../shared/types';
import { ConflictError } from '../../../../shared/errors';
import { matchesName } from '../../../../shared/name-matching';

const EMPLOYEE_COLUMNS = {
  id: employees.id,
  firstName: employees.firstName,
  lastName: employees.lastName,
  email: employees.email,
  department: employees.department,
  position: employees.position,
  startDate: employees.startDate,
  status: employees.status,
  managerId: employees.managerId,
  createdAt: employees.createdAt,
  updatedAt: employees.updatedAt,
} as const;

type EmployeeRow = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  department: string | null;
  position: string;
  startDate: string;
  status: string;
  managerId: string | null;
  createdAt: string;
  updatedAt: string;
};

function toDomain(row: EmployeeRow): Employee {
  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    department: row.department,
    position: row.position,
    startDate: row.startDate,
    status: row.status as EmployeeStatus,
    managerId: row.managerId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleEmployeeRepository implements EmployeeRepository {
  constructor(private readonly resolveDb: () => DatabaseInstance = getDb) {}

  async save(employee: Employee): Promise<void> {
    const db = this.resolveDb();

    try {
      await db.insert(employees).values(employee).onConflictDoUpdate({
        target: employees.id,
        set: employee,
      });
    } catch (error) {
      await this.explainEmailConflict(employee.email, error);
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    const db = this.resolveDb();

    await db
      .update(employees)
      .set({ deletedAt: new Date().toISOString() })
      .where(and(eq(employees.id, id), isNull(employees.deletedAt)));
  }

  async findById(id: string): Promise<Employee | null> {
    const db = this.resolveDb();
    const row = await db
      .select(EMPLOYEE_COLUMNS)
      .from(employees)
      .where(and(eq(employees.id, id), isNull(employees.deletedAt)))
      .get();

    return row ? toDomain(row) : null;
  }

  async findByEmail(email: string): Promise<Employee | null> {
    const db = this.resolveDb();
    const row = await db
      .select(EMPLOYEE_COLUMNS)
      .from(employees)
      .where(and(eq(employees.email, email), isNull(employees.deletedAt)))
      .get();

    return row ? toDomain(row) : null;
  }

  async findByName(query: string, limit: number): Promise<Employee[]> {
    if (limit <= 0) return [];

    const db = this.resolveDb();
    const rows = await db
      .select(EMPLOYEE_COLUMNS)
      .from(employees)
      .where(isNull(employees.deletedAt))
      .orderBy(employees.lastName, employees.firstName);

    const matches: Employee[] = [];
    for (const row of rows) {
      if (matches.length >= limit) break;
      if (matchesName(query, [row.firstName, row.lastName, `${row.firstName} ${row.lastName}`])) {
        matches.push(toDomain(row));
      }
    }

    return matches;
  }

  async findAll(): Promise<Employee[]> {
    const db = this.resolveDb();
    const rows = await db
      .select(EMPLOYEE_COLUMNS)
      .from(employees)
      .where(isNull(employees.deletedAt))
      .orderBy(employees.id);

    return rows.map(toDomain);
  }

  private async explainEmailConflict(email: string, error: unknown): Promise<void> {
    if (!isUniqueConstraintViolation(error)) return;

    const db = this.resolveDb();
    const supprime = await db
      .select({ id: employees.id, deletedAt: employees.deletedAt })
      .from(employees)
      .where(and(eq(employees.email, email), isNotNull(employees.deletedAt)))
      .get();

    if (!supprime) return;

    throw new ConflictError(
      `L'adresse ${email} est encore occupée par une fiche supprimée le ${supprime.deletedAt}. ` +
        `Réactiver cette fiche ou libérer l'adresse avant de recréer un employé.`,
      { cause: error },
    );
  }
}

function isUniqueConstraintViolation(error: unknown): boolean {
  for (let current: unknown = error; current; current = (current as { cause?: unknown }).cause) {
    const texte = `${(current as { code?: string }).code ?? ''} ${
      (current as { message?: string }).message ?? ''
    }`;
    if (/SQLITE_CONSTRAINT|UNIQUE constraint failed/i.test(texte)) return true;
  }
  return false;
}

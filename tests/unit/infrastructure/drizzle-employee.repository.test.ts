import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDb, closeDb } from '../../../src/infrastructure/database/connection';
import { DrizzleEmployeeRepository } from '../../../src/features/employee/infrastructure/repositories/drizzle-employee.repository';
import { createEmployee } from '../../../src/features/employee/domain/entities/employee';
import { EmployeeStatus } from '../../../src/shared/types';
import { sql } from 'drizzle-orm';

describe('Infrastructure: DrizzleEmployeeRepository', () => {
  const repo = new DrizzleEmployeeRepository();

  beforeAll(async () => {
    // Clear the employees table for tests
    // await db.run(sql`DELETE FROM employees`);
  });

  afterAll(async () => {
    await closeDb();
  });

  it('301. should create an employee in the database', async () => {
    const emp = createEmployee({
      id: 'emp-db-1',
      firstName: 'DB',
      lastName: 'Test',
      email: 'db.test@kisso.com',
      department: 'IT',
      position: 'Tester',
      startDate: '2026-08-01',
      managerId: null,
    });

    await repo.save(emp);

    const found = await repo.findById('emp-db-1');
    expect(found).toBeDefined();
    expect(found?.email).toBe('db.test@kisso.com');
  });

  it('321. should throw SQL constraint error on duplicate email', async () => {
    const emp2 = createEmployee({
      id: 'emp-db-2',
      firstName: 'DB2',
      lastName: 'Test2',
      email: 'db.test@kisso.com', // Duplicate email
      department: 'IT',
      position: 'Tester',
      startDate: '2026-08-01',
      managerId: null,
    });

    // This should fail at the DB level due to UNIQUE constraint on email
    await expect(repo.save(emp2)).rejects.toThrow();
  });
});

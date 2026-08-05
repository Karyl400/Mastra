import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DrizzleEmployeeRepository } from '../../../src/features/employee/infrastructure/repositories/drizzle-employee.repository';
import { getDb, closeDb } from '../../../src/infrastructure/database/connection';
import { EmployeeStatus } from '../../../src/shared/types';
import { randomUUID } from 'crypto';

describe('Integration: DrizzleEmployeeRepository', () => {
  let repository: DrizzleEmployeeRepository;

  beforeAll(() => {
    // getDb() will use 'test.db' because of NODE_ENV='test' in setup.ts
    const db = getDb();
    repository = new DrizzleEmployeeRepository();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('should save and retrieve an employee', async () => {
    const employeeId = randomUUID();
    const employee = {
      id: employeeId,
      firstName: 'Integration',
      lastName: 'Test',
      email: `integration.${employeeId}@kisso.com`,
      department: 'QA',
      position: 'Tester',
      startDate: new Date().toISOString(),
      status: EmployeeStatus.Pending,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Save
    await repository.save(employee);

    // Retrieve
    const retrieved = await repository.findById(employeeId);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe(employeeId);
    expect(retrieved?.firstName).toBe('Integration');
    expect(retrieved?.email).toBe(employee.email);
  });

  it('should update an existing employee (Upsert behavior)', async () => {
    const employeeId = randomUUID();
    const employee = {
      id: employeeId,
      firstName: 'Upsert',
      lastName: 'Test',
      email: `upsert.${employeeId}@kisso.com`,
      department: 'QA',
      position: 'Tester',
      startDate: new Date().toISOString(),
      status: EmployeeStatus.Pending,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // First save
    await repository.save(employee);

    // Modify and save again
    const updatedEmployee = {
      ...employee,
      status: EmployeeStatus.Active, // Changed status
      position: 'Lead Tester', // Changed position
    };

    await repository.save(updatedEmployee);

    // Retrieve and verify
    const retrieved = await repository.findById(employeeId);
    expect(retrieved?.status).toBe(EmployeeStatus.Active);
    expect(retrieved?.position).toBe('Lead Tester');
  });

  it('should return null for non-existent employee', async () => {
    const retrieved = await repository.findById(randomUUID());
    expect(retrieved).toBeNull();
  });
});

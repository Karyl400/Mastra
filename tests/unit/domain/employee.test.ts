import { describe, it, expect } from 'vitest';
import { createEmployee } from '../../../src/features/employee/domain/entities/employee';
import { EmployeeStatus } from '../../../src/shared/types';

describe('Entity: Employee', () => {
  it('should successfully create an employee with default status Pending', () => {
    const data = {
      id: 'emp-123',
      firstName: 'Alice',
      lastName: 'Smith',
      email: 'alice.smith@kisso.com',
      department: 'Engineering',
      position: 'Senior Developer',
      startDate: '2026-08-01',
      managerId: 'mgr-456'
    };

    const employee = createEmployee(data);

    expect(employee.id).toBe(data.id);
    expect(employee.firstName).toBe(data.firstName);
    expect(employee.email).toBe(data.email);
    expect(employee.status).toBe(EmployeeStatus.Pending); // Business rule validation
    
    // Timestamps should be auto-generated
    expect(employee.createdAt).toBeDefined();
    expect(employee.updatedAt).toBeDefined();
    
    // createdAt and updatedAt should be valid ISO strings
    expect(new Date(employee.createdAt).toISOString()).toBe(employee.createdAt);
  });

  it('should successfully create an employee without a managerId', () => {
    const data = {
      id: 'emp-124',
      firstName: 'Bob',
      lastName: 'Jones',
      email: 'bob@kisso.com',
      department: 'HR',
      position: 'HR Manager',
      startDate: '2026-08-01'
    };

    const employee = createEmployee(data);
    expect(employee.managerId).toBeUndefined();
    expect(employee.status).toBe(EmployeeStatus.Pending);
  });

  it('211. should enforce immutability (readonly properties)', () => {
    const data = {
      id: 'emp-immutable',
      firstName: 'Bob',
      lastName: 'Jones',
      email: 'bob@kisso.com',
      department: 'HR',
      position: 'HR Manager',
      startDate: '2026-08-01'
    };

    const employee = createEmployee(data);
    // This is checking if the factory actually freezes the object at runtime to guarantee immutability.
    expect(Object.isFrozen(employee)).toBe(true);
  });
});

import { EmployeeStatus, type Timestamps } from '../../../../shared/types';

export interface Employee extends Timestamps {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly department: string;
  readonly position: string;
  readonly startDate: string;
  readonly status: EmployeeStatus;
  readonly managerId?: string | null;
}

export function createEmployee(data: Omit<Employee, keyof Timestamps | 'status'>): Employee {
  const now = new Date().toISOString();
  return Object.freeze({
    ...data,
    status: EmployeeStatus.Pending,
    createdAt: now,
    updatedAt: now,
  });
}

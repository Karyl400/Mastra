import type { Employee } from '../entities/employee';

export interface EmployeeRepository {
  findById(id: string): Promise<Employee | null>;
  findByEmail(email: string): Promise<Employee | null>;
  findAll(): Promise<Employee[]>;
  save(employee: Employee): Promise<void>;
  update(employee: Employee): Promise<void>;
  delete(id: string): Promise<void>;
}

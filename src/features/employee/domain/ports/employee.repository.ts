import type { Employee } from '../entities/employee';

export interface EmployeeRepository {
  findById(id: string): Promise<Employee | null>;
  findByEmail(email: string): Promise<Employee | null>;

  findByName(query: string, limit: number): Promise<Employee[]>;

  findAll(): Promise<Employee[]>;
  save(employee: Employee): Promise<void>;
  delete(id: string): Promise<void>;
}

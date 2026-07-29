import type { Employee } from '../../domain/entities/employee';
import type { EmployeeRepository } from '../../domain/ports/employee.repository';

export class InMemoryEmployeeRepository implements EmployeeRepository {
  private store = new Map<string, Employee>();

  async findById(id: string): Promise<Employee | null> {
    return this.store.get(id) ?? null;
  }

  async findByEmail(email: string): Promise<Employee | null> {
    for (const e of this.store.values()) {
      if (e.email === email) return e;
    }
    return null;
  }

  async findAll(): Promise<Employee[]> {
    return Array.from(this.store.values());
  }

  async save(employee: Employee): Promise<void> {
    this.store.set(employee.id, employee);
  }

  async update(employee: Employee): Promise<void> {
    this.store.set(employee.id, employee);
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }
}

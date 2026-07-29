import { eq } from 'drizzle-orm';
import { getDb } from '../../../../infrastructure/database/connection';
import { employees } from '../../../../infrastructure/database/schema';
import { Employee } from '../../domain/entities/employee';
import { EmployeeRepository } from '../../domain/ports/employee.repository';

export class DrizzleEmployeeRepository implements EmployeeRepository {
  async save(employee: Employee): Promise<void> {
    const db = getDb();
    await db.insert(employees).values(employee).onConflictDoUpdate({
      target: employees.id,
      set: employee,
    });
  }

  async update(employee: Employee): Promise<void> {
    await this.save(employee);
  }

  async delete(id: string): Promise<void> {
    const db = getDb();
    await db.delete(employees).where(eq(employees.id, id));
  }

  async findById(id: string): Promise<Employee | null> {
    const db = getDb();
    const result = await db.select().from(employees).where(eq(employees.id, id)).get();
    if (!result) return null;
    return result as Employee;
  }

  async findByEmail(email: string): Promise<Employee | null> {
    const db = getDb();
    const result = await db.select().from(employees).where(eq(employees.email, email)).get();
    if (!result) return null;
    return result as Employee;
  }

  async findAll(): Promise<Employee[]> {
    const db = getDb();
    const result = await db.select().from(employees);
    return result as Employee[];
  }
}

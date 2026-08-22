import type { Employee } from '../../domain/entities/employee';
import type { EmployeeRepository } from '../../domain/ports/employee.repository';
import { ConflictError } from '../../../../shared/errors';
import { matchesName } from '../../../../shared/name-matching';

export class InMemoryEmployeeRepository implements EmployeeRepository {
  private store = new Map<string, Employee>();

  private deletedAt = new Map<string, string>();

  async findById(id: string): Promise<Employee | null> {
    if (this.deletedAt.has(id)) return null;
    return this.store.get(id) ?? null;
  }

  async findByEmail(email: string): Promise<Employee | null> {
    for (const e of this.store.values()) {
      if (e.email === email && !this.deletedAt.has(e.id)) return e;
    }
    return null;
  }

  async findByName(query: string, limit: number): Promise<Employee[]> {
    if (limit <= 0) return [];

    return Array.from(this.store.values())
      .filter((e) => !this.deletedAt.has(e.id))
      .filter((e) => matchesName(query, [e.firstName, e.lastName, `${e.firstName} ${e.lastName}`]))
      .sort(
        (a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName),
      )
      .slice(0, limit);
  }

  async findAll(): Promise<Employee[]> {
    return Array.from(this.store.values()).filter((e) => !this.deletedAt.has(e.id));
  }

  async save(employee: Employee): Promise<void> {
    for (const existant of this.store.values()) {
      if (existant.email !== employee.email || existant.id === employee.id) continue;

      const dateSuppression = this.deletedAt.get(existant.id);
      if (dateSuppression) {
        throw new ConflictError(
          `L'adresse ${employee.email} est encore occupée par une fiche supprimée le ${dateSuppression}. ` +
            `Réactiver cette fiche ou libérer l'adresse avant de recréer un employé.`,
        );
      }

      throw new ConflictError(`L'adresse ${employee.email} est déjà utilisée.`);
    }

    this.store.set(employee.id, employee);
  }

  async delete(id: string): Promise<void> {
    if (!this.store.has(id) || this.deletedAt.has(id)) return;
    this.deletedAt.set(id, new Date().toISOString());
  }
}

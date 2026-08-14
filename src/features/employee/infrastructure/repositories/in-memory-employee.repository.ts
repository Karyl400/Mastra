import type { Employee } from '../../domain/entities/employee';
import type { EmployeeRepository } from '../../domain/ports/employee.repository';
import { ConflictError } from '../../../../shared/errors';
import { matchesName } from '../../../../shared/name-matching';

/**
 * Doublure de `DrizzleEmployeeRepository`, utilisée par tous les tests de tools.
 *
 * ⚠️ Elle doit se comporter comme l'implémentation réelle, y compris sur le soft delete : si
 * elle diverge, le run unitaire valide un comportement que la production n'a pas. C'est le
 * contrat que verrouille `tests/unit/repositories/employee-soft-delete.test.ts`, exécuté sur
 * les DEUX implémentations.
 */
export class InMemoryEmployeeRepository implements EmployeeRepository {
  private store = new Map<string, Employee>();

  /**
   * L'état de suppression vit HORS de `store`, et c'est ce qui reproduit la propriété que le SQL
   * obtient en ne nommant pas `deleted_at` dans son upsert : `save()`/`update()` réécrivent la
   * fiche sans toucher à sa suppression, donc aucune résurrection accidentelle.
   */
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

  /** Même rapprochement que la production — le module partagé est le seul juge. */
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
    // Reproduit la contrainte UNIQUE sur l'email, que le soft delete rend visible : une fiche
    // supprimée OCCUPE toujours son adresse. Sans cela, la doublure accepterait une création que
    // la production refuse — l'écart le plus coûteux qu'une doublure puisse porter.
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

  async update(employee: Employee): Promise<void> {
    await this.save(employee);
  }

  /** Idempotent, comme le `WHERE deleted_at IS NULL` du SQL : la date d'origine ne bouge pas. */
  async delete(id: string): Promise<void> {
    if (!this.store.has(id) || this.deletedAt.has(id)) return;
    this.deletedAt.set(id, new Date().toISOString());
  }
}

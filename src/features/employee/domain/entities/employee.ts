import { EmployeeStatus, type Timestamps } from '../../../../shared/types';

export interface Employee extends Timestamps {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  /**
   * FACULTATIF depuis le 2026-08-13 — le parcours d'arrivée ne le collecte plus.
   *
   * `null` et non `''` : une chaîne vide serait indiscernable d'une saisie effacée, et tout
   * lecteur finirait par l'afficher telle quelle. `null` dit « pas de valeur », ce que le
   * moindre `if` sait lire.
   */
  readonly department: string | null;
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

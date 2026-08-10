/**
 * Port « annuaire » de la feature `notification`.
 *
 * Vue minimale et en LECTURE SEULE d'un employé, restreinte à ce dont cette feature a
 * besoin : résoudre une adresse de destination à partir d'un identifiant.
 *
 * Comme `src/features/document/domain/ports/employee.repository.ts`, ce port duplique
 * volontairement une partie du port de la feature `employee` : chaque feature possède ses
 * propres ports (cf. CLAUDE.md). La feature `notification` n'importe donc jamais les
 * internes de la feature `employee` ; c'est `src/mastra/index.ts` qui branche
 * l'implémentation Drizzle, structurellement compatible avec cette interface.
 */

/** Enregistrement d'annuaire — la seule source de vérité pour une adresse de destination. */
export interface EmployeeDirectoryRecord {
  readonly id: string;
  readonly email: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly managerId?: string | null;
}

export interface EmployeeRepository {
  findById(id: string): Promise<EmployeeDirectoryRecord | null>;
}

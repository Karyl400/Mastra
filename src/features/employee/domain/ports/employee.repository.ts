import type { Employee } from '../entities/employee';

export interface EmployeeRepository {
  findById(id: string): Promise<Employee | null>;
  findByEmail(email: string): Promise<Employee | null>;

  /**
   * Résout une personne par son NOM, accents et casse ignorés.
   *
   * ⚠️ Rend une LISTE, jamais un seul résultat, et c'est le point du contrat. Deux
   * homonymes existent dans tout workspace un peu grand ; en choisir un serait décider à
   * la place de l'humain sur une valeur qui finit par désigner un destinataire d'email.
   * L'appelant doit pouvoir constater l'ambiguïté.
   *
   * Le rapprochement lui-même vit dans `src/shared/name-matching.ts` — le même code des
   * deux côtés (ici et `DirectoryRepository`), sans quoi une personne serait résolvable
   * dans une table et pas dans l'autre.
   *
   * `limit` borne le retour : une requête d'un seul caractère peut correspondre à
   * beaucoup de monde, et ce résultat repart dans la fenêtre d'un modèle.
   */
  findByName(query: string, limit: number): Promise<Employee[]>;

  findAll(): Promise<Employee[]>;
  save(employee: Employee): Promise<void>;
  update(employee: Employee): Promise<void>;
  delete(id: string): Promise<void>;
}

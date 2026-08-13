/**
 * Port employé PROPRE à la feature `document` — il duplique délibérément celui de la feature
 * `employee` : chaque feature possède ses propres ports, et ce dédoublement est documenté
 * comme intentionnel dans `CLAUDE.md`.
 *
 * Il est aussi plus ÉTROIT : un document a besoin de nommer et de situer une personne, pas de
 * connaître son statut, son manager ni ses horodatages.
 */
export interface EmployeeRepository {
  findById(id: string): Promise<{
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    /**
     * FACULTATIF depuis le 2026-08-13 — le parcours d'arrivée ne le collecte plus. Les
     * gabarits omettent la ligne quand la valeur manque, plutôt que d'imprimer « N/A » ou
     * « Général » dans un document signé de l'entreprise.
     */
    department: string | null;
    position: string;
    startDate: string;
  } | null>;
}

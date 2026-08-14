import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { getDb, type DatabaseInstance } from '../../../../infrastructure/database/connection';
import { employees } from '../../../../infrastructure/database/schema';
import { Employee } from '../../domain/entities/employee';
import { EmployeeRepository } from '../../domain/ports/employee.repository';
import { EmployeeStatus } from '../../../../shared/types';
import { ConflictError } from '../../../../shared/errors';
import { matchesName } from '../../../../shared/name-matching';

/**
 * PROJECTION EXPLICITE — le point le plus important de ce fichier.
 *
 * Ces lectures faisaient `db.select().from(employees)`, c'est-à-dire `SELECT *` sur les
 * 20 colonnes de la table, puis `return result as Employee`. L'assertion de type DISPARAÎT à
 * l'exécution : elle apaisait le compilateur, elle ne retirait pas une seule colonne de l'objet.
 * `salary_amount`, `emergency_contact_name`, `emergency_contact_phone`, `phone` et `metadata`
 * repartaient donc intacts vers l'appelant — et `getEmployeeProfile` est câblé aux TROIS agents,
 * ce qui les envoyait chez Groq puis chez Mistral à chaque consultation de fiche.
 *
 * L'énumération ci-dessous est exactement l'interface `Employee` du domaine, champ pour champ.
 * Ce n'est pas une redondance avec elle : c'est la seule forme qui fasse porter la restriction
 * par le SQL plutôt que par une promesse du système de types. Ajouter un champ au domaine sans
 * l'ajouter ici produit une erreur de compilation dans `toDomain` — l'inverse, ajouter une
 * colonne sensible à la table, ne produit désormais plus rien du tout, ce qui est le but.
 */
const EMPLOYEE_COLUMNS = {
  id: employees.id,
  firstName: employees.firstName,
  lastName: employees.lastName,
  email: employees.email,
  department: employees.department,
  position: employees.position,
  startDate: employees.startDate,
  status: employees.status,
  managerId: employees.managerId,
  createdAt: employees.createdAt,
  updatedAt: employees.updatedAt,
} as const;

/**
 * Forme rendue par la projection. Écrite explicitement plutôt que dérivée de
 * `EMPLOYEE_COLUMNS` : Drizzle expose `_['data']` SANS la nullabilité de la colonne, donc un
 * type mappé rendrait `managerId: string` là où le SQL rend `string | null` — un mensonge de
 * type sur exactement le genre de champ qui produit un « null » imprimé en production.
 *
 * Ajouter un champ à l'interface `Employee` du domaine casse `toDomain`, ce qui force à
 * l'ajouter ici, ce qui force à l'ajouter dans `EMPLOYEE_COLUMNS` : la chaîne tient.
 */
type EmployeeRow = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  department: string | null;
  position: string;
  startDate: string;
  status: string;
  managerId: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Seul point où `status` redevient l'énumération du domaine : la colonne est un `text` libre. */
function toDomain(row: EmployeeRow): Employee {
  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    department: row.department,
    position: row.position,
    startDate: row.startDate,
    status: row.status as EmployeeStatus,
    managerId: row.managerId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleEmployeeRepository implements EmployeeRepository {
  /**
   * Connexion résolue PARESSEUSEMENT (fonction, pas instance) : la construire ici ouvrirait la
   * base au chargement du module, donc au câblage de `src/mastra/index.ts`. Le paramètre sert
   * aussi aux tests, qui injectent une base libsql en mémoire plutôt que de mocker Drizzle.
   */
  constructor(private readonly resolveDb: () => DatabaseInstance = getDb) {}

  /**
   * L'upsert ne NOMME jamais `deleted_at`, et c'est ce qui empêche une résurrection accidentelle :
   * `update()` délègue ici, donc un enregistrement rejoué sur l'identifiant d'une fiche supprimée
   * retombe sur sa ligne. Il en met à jour les champs métier et laisse la suppression en place.
   * Réactiver une fiche sera un geste EXPLICITE le jour où il existera, jamais un effet de bord.
   */
  async save(employee: Employee): Promise<void> {
    const db = this.resolveDb();

    try {
      await db.insert(employees).values(employee).onConflictDoUpdate({
        target: employees.id,
        set: employee,
      });
    } catch (error) {
      await this.explainEmailConflict(employee.email, error);
      throw error;
    }
  }

  async update(employee: Employee): Promise<void> {
    await this.save(employee);
  }

  /**
   * SOFT DELETE. `employees.deleted_at` et son index existaient depuis l'origine, mais cette
   * méthode faisait un DELETE PHYSIQUE : l'index était mort et toute suppression détruisait la
   * donnée sans trace ni réversibilité — dans un système RH, où la conservation est une
   * obligation avant d'être un confort.
   *
   * Le `isNull` de la clause WHERE porte la propriété d'idempotence : un second appel n'affecte
   * aucune ligne et ne DÉPLACE donc pas la date. C'est la trace de la suppression ORIGINELLE,
   * seule information réutilisable pour un audit ou une restauration.
   *
   * Un identifiant inconnu n'affecte aucune ligne et ne lève pas — c'est déjà le contrat de
   * l'ancien `delete()`, et les appelants s'en remettent à lui.
   */
  async delete(id: string): Promise<void> {
    const db = this.resolveDb();

    await db
      .update(employees)
      .set({ deletedAt: new Date().toISOString() })
      .where(and(eq(employees.id, id), isNull(employees.deletedAt)));
  }

  async findById(id: string): Promise<Employee | null> {
    const db = this.resolveDb();
    const row = await db
      .select(EMPLOYEE_COLUMNS)
      .from(employees)
      .where(and(eq(employees.id, id), isNull(employees.deletedAt)))
      .get();

    return row ? toDomain(row) : null;
  }

  async findByEmail(email: string): Promise<Employee | null> {
    const db = this.resolveDb();
    const row = await db
      .select(EMPLOYEE_COLUMNS)
      .from(employees)
      .where(and(eq(employees.email, email), isNull(employees.deletedAt)))
      .get();

    return row ? toDomain(row) : null;
  }

  /**
   * Résolution par nom : UN aller-retour, puis le rapprochement en mémoire.
   *
   * ── Pourquoi pas en SQL ─────────────────────────────────────────────────────────────
   * `lower()` de SQLite ne retire pas les accents (pas d'ICU dans le build LibSQL), et un
   * `LIKE '%needle%'` correspondrait au MILIEU des mots : « rao » retrouverait « Traoré ».
   * Sur une résolution qui finit par désigner le destinataire d'un email, une
   * correspondance approximative est exactement le défaut qu'on corrige — il a déjà envoyé
   * le document d'Awa à l'adresse de Karyl le 2026-08-13.
   *
   * ── Le coût, et sa borne ────────────────────────────────────────────────────────────
   * On lit donc les fiches vivantes et on filtre en mémoire. La projection
   * `EMPLOYEE_COLUMNS` s'applique (aucune colonne sensible ne quitte la base) et
   * `employees` compte 2 lignes en production au 2026-08-14 — c'est la table des salariés
   * ENREGISTRÉS, elle croît au rythme des arrivées, pas des messages.
   *
   * ⚠️ Le jour où elle passera quelques milliers de lignes, la réponse n'est pas un `LIKE`
   * (il réintroduirait la correspondance en milieu de mot) mais une colonne normalisée
   * persistée, indexée, écrite par le même `normalizeName`.
   */
  async findByName(query: string, limit: number): Promise<Employee[]> {
    if (limit <= 0) return [];

    const db = this.resolveDb();
    const rows = await db
      .select(EMPLOYEE_COLUMNS)
      .from(employees)
      .where(isNull(employees.deletedAt))
      .orderBy(employees.lastName, employees.firstName);

    const matches: Employee[] = [];
    for (const row of rows) {
      if (matches.length >= limit) break;
      if (matchesName(query, [row.firstName, row.lastName, `${row.firstName} ${row.lastName}`])) {
        matches.push(toDomain(row));
      }
    }

    return matches;
  }

  async findAll(): Promise<Employee[]> {
    const db = this.resolveDb();
    const rows = await db
      .select(EMPLOYEE_COLUMNS)
      .from(employees)
      .where(isNull(employees.deletedAt))
      .orderBy(employees.id);

    return rows.map(toDomain);
  }

  /**
   * Le soft delete crée un cas que le hard delete ne pouvait pas produire : une ligne SUPPRIMÉE
   * occupe toujours son adresse, car la contrainte UNIQUE porte sur la colonne et ignore
   * `deleted_at`. Recréer un employé sur l'email d'un partant échoue donc, avec le message brut
   * du pilote — « UNIQUE constraint failed: employees.email » — qui ne dit rien de la cause.
   *
   * On ne relâche PAS la contrainte (un index partiel laisserait deux vivants coexister le temps
   * d'une réactivation) et on n'avale pas l'erreur : on la NOMME. Le seul comportement
   * inacceptable ici serait un échec silencieux — ce dépôt en a déjà payé trois.
   *
   * Quand la ligne en place est VIVANTE, c'est un doublon ordinaire : on ne s'en mêle pas et
   * l'erreur d'origine remonte telle quelle. Parler de suppression y serait un mensonge.
   */
  private async explainEmailConflict(email: string, error: unknown): Promise<void> {
    if (!isUniqueConstraintViolation(error)) return;

    const db = this.resolveDb();
    const supprime = await db
      .select({ id: employees.id, deletedAt: employees.deletedAt })
      .from(employees)
      .where(and(eq(employees.email, email), isNotNull(employees.deletedAt)))
      .get();

    if (!supprime) return;

    throw new ConflictError(
      `L'adresse ${email} est encore occupée par une fiche supprimée le ${supprime.deletedAt}. ` +
        `Réactiver cette fiche ou libérer l'adresse avant de recréer un employé.`,
      { cause: error },
    );
  }
}

/**
 * Le pilote libSQL ne classe pas ses erreurs : on lit le texte. Les deux formes rencontrées sont
 * `SQLITE_CONSTRAINT_UNIQUE` (code) et `UNIQUE constraint failed` (message) selon que l'erreur
 * remonte du client ou de l'enrobage Drizzle.
 */
function isUniqueConstraintViolation(error: unknown): boolean {
  for (let current: unknown = error; current; current = (current as { cause?: unknown }).cause) {
    const texte = `${(current as { code?: string }).code ?? ''} ${
      (current as { message?: string }).message ?? ''
    }`;
    if (/SQLITE_CONSTRAINT|UNIQUE constraint failed/i.test(texte)) return true;
  }
  return false;
}

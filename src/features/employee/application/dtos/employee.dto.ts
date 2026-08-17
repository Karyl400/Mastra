// employee.validation.ts
import { z } from 'zod';
// Sous-chemin — voir la note d'`isEmail` dans `shared/validation.ts`.
import contains from 'validator/lib/contains.js';
import { sanitizeHtml } from '../../../../shared/security/html-sanitizer.js';
import { EmployeeStatus, Department } from '../../../../shared/types';
import { emailSchema, timestampsSchema, uuidSchema } from '../../../../shared/validation';

// ============================================
// 1. CONSTANTES ET CONFIGURATION
// ============================================

const EMPLOYEE_CONSTRAINTS = {
  NAME: {
    MIN_LENGTH: 1,
    MAX_LENGTH: 100,
    PATTERN: /^[a-zA-ZÀ-ÿ\s'-]+$/, // Support noms internationaux
    MESSAGE: 'Name must contain only letters, spaces, hyphens, and apostrophes',
  },
  DEPARTMENT: {
    MIN_LENGTH: 2,
    MAX_LENGTH: 100,
  },
  POSITION: {
    MIN_LENGTH: 2,
    MAX_LENGTH: 150,
  },
  START_DATE: {
    MIN_YEAR: 2000,
    MAX_FUTURE_DAYS: 90, // Maximum 90 jours dans le futur
  },
  SALARY: {
    MIN: 0,
    MAX: 1_000_000_000, // 1 milliard
  },
} as const;

// ============================================
// 2. SCHEMAS DE BASE AMÉLIORÉS
// ============================================

/**
 * Schema de nom avec validation internationale
 * Supporte les caractères Unicode pour les noms non-latins
 */
const nameSchema = z
  .string()
  .trim()
  .min(
    EMPLOYEE_CONSTRAINTS.NAME.MIN_LENGTH,
    `Name must be at least ${EMPLOYEE_CONSTRAINTS.NAME.MIN_LENGTH} character`,
  )
  .max(
    EMPLOYEE_CONSTRAINTS.NAME.MAX_LENGTH,
    `Name must not exceed ${EMPLOYEE_CONSTRAINTS.NAME.MAX_LENGTH} characters`,
  )
  .regex(EMPLOYEE_CONSTRAINTS.NAME.PATTERN, EMPLOYEE_CONSTRAINTS.NAME.MESSAGE)
  .transform((val) => sanitizeHtml(val)) // Protection XSS
  .refine(
    (val) => !contains(val, '<script>', { ignoreCase: true }),
    'Name contains potentially unsafe content',
  );

/**
 * Schema de date avec contraintes métier
 */
const startDateSchema = z
  .string()
  .datetime({ message: 'Invalid date format. Expected ISO 8601 datetime' })
  .refine(
    (date) => {
      const parsed = new Date(date);
      const minDate = new Date(EMPLOYEE_CONSTRAINTS.START_DATE.MIN_YEAR, 0, 1);
      const maxDate = new Date();
      maxDate.setDate(maxDate.getDate() + EMPLOYEE_CONSTRAINTS.START_DATE.MAX_FUTURE_DAYS);

      return parsed >= minDate && parsed <= maxDate;
    },
    {
      message: `Start date must be between year ${EMPLOYEE_CONSTRAINTS.START_DATE.MIN_YEAR} and ${EMPLOYEE_CONSTRAINTS.START_DATE.MAX_FUTURE_DAYS} days in the future`,
    },
  )
  .transform((date) => new Date(date).toISOString()); // Normalisation

/**
 * Schema département avec enum dynamique
 */
const departmentSchema = z
  .string()
  .trim()
  .min(EMPLOYEE_CONSTRAINTS.DEPARTMENT.MIN_LENGTH)
  .max(EMPLOYEE_CONSTRAINTS.DEPARTMENT.MAX_LENGTH)
  .pipe(z.nativeEnum(Department)) // Validation contre l'enum après nettoyage
  .transform((val) => sanitizeHtml(val));

// ============================================
// 3. SCHEMAS MÉTIER COMPLEXES
// ============================================

// ⚠️ `managerValidationSchema` a été SUPPRIMÉ le 2026-08-17 — il n'avait aucun appelant.
// Il déclarait deux règles métier (« un employé actif doit avoir un manager », « un employé
// en attente ne peut pas en avoir ») que RIEN n'appliquait : le seul chemin de création
// réel est le formulaire « Compléter mon profil », qui ne collecte aucun manager et crée
// des dossiers actifs. La règle était donc à la fois morte ET fausse pour ce produit —
// la câbler aurait cassé le formulaire.
//
// Une règle qu'aucun code n'applique est de la même famille que `emailSent: false` sous
// `status: 'success'` : elle donne l'illusion d'une garantie. Si le rattachement
// hiérarchique devient un vrai besoin, il se réécrira contre le parcours qui existera
// alors, pas contre celui de 2026-08-05.

// ============================================
// 4. SCHEMA PRINCIPAL AVEC DISCRIMINATED UNIONS
// ============================================

/**
 * Schema de base commun à tous les employés
 */
const baseEmployeeSchema = z.object({
  firstName: nameSchema,
  lastName: nameSchema,
  // ⚠️ Le `.refine()` qui enrobait ce champ a été RETIRÉ le 2026-08-17 : son prédicat
  // retournait `true` en toute circonstance, sous le message « Email already exists in
  // the system ». Il ne pouvait donc rien refuser, tout en faisant croire à un contrôle
  // d'unicité — un test de schéma l'aurait vu « passer » sans qu'aucune vérification
  // n'ait lieu. L'unicité EST vérifiée, mais là où elle peut l'être : la contrainte
  // `UNIQUE` de la table et `findByEmail` dans `createEmployeeStep`.
  email: emailSchema,
  // NULLABLE depuis le 2026-08-13 : le parcours d'arrivée ne collecte plus le département.
  // Le schéma de VALEUR reste inchangé — quand une valeur est présente, elle doit toujours
  // appartenir à l'enum. On assouplit la présence, jamais la validité.
  department: departmentSchema.nullable(),
  // Champ libre : voir `positionSchema` dans shared/validation.ts. Le `.pipe()`
  // qui figurait ici sérialisait en `allOf` — exactement la construction que
  // `tool-schema-flatness.test.ts` interdit, et qui a déjà cassé `createEmployee`.
  // Elle ne survivait que parce que ce schéma n'est pas un `inputSchema` de tool.
  position: z
    .string()
    .trim()
    .min(EMPLOYEE_CONSTRAINTS.POSITION.MIN_LENGTH)
    .max(EMPLOYEE_CONSTRAINTS.POSITION.MAX_LENGTH)
    .transform((val) => sanitizeHtml(val)),
  startDate: startDateSchema,
  status: z.nativeEnum(EmployeeStatus).default(EmployeeStatus.Pending),
});

const applyManagerValidation = <T extends z.ZodTypeAny>(schema: T) => {
  return schema
    .refine(
      (data: { status?: string; managerId?: string | null }) =>
        !(data.status === EmployeeStatus.Active && !data.managerId),
      {
        message: 'Active employees must have a manager assigned',
        path: ['managerId'],
      },
    )
    .refine(
      (data: { status?: string; managerId?: string | null }) =>
        !(data.status === EmployeeStatus.Pending && data.managerId),
      {
        message: 'Pending employees cannot have a manager assigned',
        path: ['managerId'],
      },
    );
};

/**
 * Schema pour la réponse (DTO) — le SEUL schéma vivant de ce module.
 */
export const employeeDtoSchema = applyManagerValidation(
  baseEmployeeSchema
    .extend({
      id: uuidSchema,
      managerId: uuidSchema.nullable().optional(),

      // Champs calculés
      fullName: z.string().optional(),
      tenure: z.number().optional(), // Ancienneté en mois
    })
    .merge(timestampsSchema),
);

// ============================================
// 5. TYPES INFÉRÉS
// ============================================

export type EmployeeDto = z.infer<typeof employeeDtoSchema>;

// ============================================
// ⚠️ SECTIONS 6 À 9 SUPPRIMÉES LE 2026-08-17
// ============================================
//
// Ce module faisait 474 lignes pour DEUX symboles réellement importés :
// `EmployeeDto` (par `employee.mapper.ts`) et `employeeDtoSchema` (par son seul test).
// Ont été retirés :
//
//  • `EmployeeValidator` — une classe de validation à zéro appelant, seule consommatrice
//    de `createEmployeeSchema` et d'`updateEmployeeSchema`, eux-mêmes sans importateur.
//    C'est ce qui rendait morte la règle « un employé actif doit avoir un manager » :
//    elle EXISTAIT, mais aucun chemin d'exécution ne la traversait.
//  • `EmployeeValidationError` — levée nulle part, donc rattrapée nulle part.
//  • `preValidationHooks` — normalisation d'entrée qu'aucun appelant n'invoquait ; le
//    parcours réel normalise dans `createEmployeeStep`.
//  • `validationTestCases` — des FIXTURES DE TEST exportées depuis le code de production,
//    qui n'étaient utilisées par aucun test. Elles décrivaient un contrat (« ces entrées
//    doivent être refusées ») que rien ne vérifiait : la forme la plus trompeuse de code
//    mort, puisqu'elle ressemble à une garantie.
//  • `EmployeeListResponse` — pagination d'une API qui n'existe pas.
//
// `applyManagerValidation` est CONSERVÉE : `employeeDtoSchema` l'applique réellement, et
// son test la traverse.

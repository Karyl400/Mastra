// ============================================
// shared/validation/index.ts - Centralized Validation Schemas
// Standards 2026: Zod + Domain-Driven + Anti-XSS
// ============================================

import { z } from 'zod';
import { sanitizeHtml, sanitizeRichHtml } from './security/html-sanitizer.js';
// Sous-chemin et non `import validator from 'validator'` : le paquet expose ~90
// validateurs, on en utilise UN. Sur Vercel le démarrage à froid du bundle est déjà
// ce qui fait dépasser les 3 s d'ACK de Slack ; chaque module inutile s'y ajoute.
import isEmail from 'validator/lib/isEmail.js';
import { Department } from './types.js';

// ============================================
// 1. CONSTANTES DE VALIDATION
// ============================================

const VALIDATION_CONSTRAINTS = {
  NAME: {
    MIN_LENGTH: 2,
    MAX_LENGTH: 100,
    // Supporte les noms internationaux (accents, apostrophes, tirets)
    // Bloque explicitement les caractères HTML et scripts
    // Simplified regex for JSON Schema compatibility (removes \p{L} etc)
    PATTERN: /^[a-zA-ZÀ-ÿ\s'-]+$/,
    MESSAGE: 'Name must contain only letters, accents, spaces, hyphens, and apostrophes',
  },
  POSITION: {
    MIN_LENGTH: 2,
    MAX_LENGTH: 150,
    // Plus permissif que NAME : un intitulé de poste porte des chiffres (« L3 »),
    // des séparateurs (« Product Manager - Growth ») et de la ponctuation
    // (« Ingénieur R&D », « Développeur (Full-Stack) »). Comme NAME, la classe
    // reste ASCII + Latin-1 : `\p{L}` casse le parseur de schémas du Vercel AI SDK.
    PATTERN: /^[a-zA-ZÀ-ÿ0-9\s'&./()-]+$/,
    MESSAGE:
      'Position must contain only letters, digits, spaces and the punctuation &./()- and apostrophes',
  },
  EMAIL: {
    MAX_LENGTH: 254, // RFC 5321
    BLOCKED_DOMAINS: ['tempmail.com', 'guerrillamail.com', '10minutemail.com'],
  },
  TITLE: {
    MIN_LENGTH: 3,
    MAX_LENGTH: 200,
    PATTERN: /^[^<>{}[\]\\]*$/, // Pas de caractères potentiellement dangereux
  },
  DESCRIPTION: {
    MAX_LENGTH: 5000,
  },
  START_DATE: {
    MIN_YEAR: 2000,
    MAX_FUTURE_DAYS: 90,
  },
  DUE_DATE: {
    MIN_DAYS_FROM_NOW: 0,
    MAX_DAYS_FROM_NOW: 365,
  },
  PAGINATION: {
    DEFAULT_PAGE: 1,
    DEFAULT_LIMIT: 20,
    MAX_LIMIT: 100,
  },
} as const;

// ============================================
// 2. FONCTIONS DE SANITIZATION
// ============================================

/**
 * Sanitize un champ texte simple (pas de HTML autorisé)
 */
function sanitizeText(value: string): string {
  return sanitizeHtml(value.trim());
}

/**
 * Sanitize un champ texte riche (HTML limité autorisé)
 */
function sanitizeRichText(value: string): string {
  return sanitizeRichHtml(value.trim());
}

/**
 * Sanitize un nom (lettres, accents, tirets, apostrophes uniquement)
 */
function sanitizeName(value: string): string {
  return (
    sanitizeHtml(value.trim())
      // `[^>]*` ne peut pas reculer devant `>`, qu'il exclut par construction : 0,03 ms
      // mesurées sur 8 000 caractères adverses.
      // eslint-disable-next-line sonarjs/super-linear-regex
      .replace(/<[^>]*>/g, '') // Supprime tout HTML résiduel
      .replace(/[^a-zA-ZÀ-ÿ\s'-]/g, '') // Garde uniquement les caractères autorisés
      .replace(/\s+/g, ' ') // Normalise les espaces
      .trim()
  );
}

// ============================================
// 3. SCHÉMAS DE BASE (Building Blocks)
// ============================================

/**
 * UUID v4 ou v7
 */
export const uuidSchema = z
  .string()
  .uuid({ message: 'Invalid UUID format' })
  .describe('UUID v4/v7 identifier');

/**
 * Email avec validation avancée
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email({ message: 'Invalid email format' })
  .max(VALIDATION_CONSTRAINTS.EMAIL.MAX_LENGTH, 'Email is too long')
  .refine(
    (email) => {
      const domain = email.split('@')[1];
      return !VALIDATION_CONSTRAINTS.EMAIL.BLOCKED_DOMAINS.includes(
        domain as unknown as (typeof VALIDATION_CONSTRAINTS.EMAIL.BLOCKED_DOMAINS)[number],
      );
    },
    { message: 'Email domain is not allowed' },
  )
  .refine((email) => isEmail(email, { allow_utf8_local_part: false }), {
    message: 'Email contains invalid characters',
  })
  .describe('Valid professional email address');

/**
 * Nom avec validation internationale — FABRIQUE.
 *
 * ⚠️ Utiliser `makeNameSchema()` (et non la constante `nameSchema`) dès qu'un même
 * objet apparaît DEUX FOIS dans un schéma exposé à un LLM (ex. `firstName` +
 * `lastName`). `zodToJsonSchema` (stratégie `relative`, celle de Mastra) déduplique
 * les instances Zod partagées et émet `{"$ref": "1/firstName"}` pour la seconde —
 * un noeud sans `type` racine, de la même famille que le `allOf` qui a cassé
 * `createEmployee`. Chaque appel de la fabrique produit une instance distincte,
 * donc un schéma entièrement inline.
 */
export const makeNameSchema = () =>
  z
    .string()
    .trim()
    .min(
      VALIDATION_CONSTRAINTS.NAME.MIN_LENGTH,
      `Name must be at least ${VALIDATION_CONSTRAINTS.NAME.MIN_LENGTH} characters`,
    )
    .max(
      VALIDATION_CONSTRAINTS.NAME.MAX_LENGTH,
      `Name must not exceed ${VALIDATION_CONSTRAINTS.NAME.MAX_LENGTH} characters`,
    )
    .regex(VALIDATION_CONSTRAINTS.NAME.PATTERN, VALIDATION_CONSTRAINTS.NAME.MESSAGE)
    .transform(sanitizeName)
    .describe('Person name (letters, accents, hyphens, apostrophes)');

/**
 * Instance partagée (rétrocompatibilité) — ne pas réutiliser deux fois
 * dans un même schéma exposé au LLM, voir `makeNameSchema`.
 */
export const nameSchema = makeNameSchema();

/**
 * Titre (tâche, document, etc.)
 */
export const titleSchema = z
  .string()
  .trim()
  .min(
    VALIDATION_CONSTRAINTS.TITLE.MIN_LENGTH,
    `Title must be at least ${VALIDATION_CONSTRAINTS.TITLE.MIN_LENGTH} characters`,
  )
  .max(
    VALIDATION_CONSTRAINTS.TITLE.MAX_LENGTH,
    `Title must not exceed ${VALIDATION_CONSTRAINTS.TITLE.MAX_LENGTH} characters`,
  )
  .regex(VALIDATION_CONSTRAINTS.TITLE.PATTERN, 'Title contains invalid characters')
  .transform(sanitizeText)
  .describe('Task or document title');

/**
 * Description (texte riche limité)
 */
export const descriptionSchema = z
  .string()
  .max(VALIDATION_CONSTRAINTS.DESCRIPTION.MAX_LENGTH, 'Description is too long')
  .transform(sanitizeRichText)
  .default('')
  .describe('Description with limited HTML formatting');

/**
 * Trim non destructif : laisse passer les valeurs non-string telles quelles
 * pour que `z.nativeEnum` produise son propre message d'erreur.
 */
function trimIfString(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * Département
 *
 * ⚠️ NE PAS réintroduire `z.string()....pipe(z.nativeEnum(...))` ici.
 * `.pipe()` sérialise en `allOf: [{...}, {...}]` — un objet JSON Schema sans `type`
 * racine — et le validateur de tool-calls de Groq le traite comme un `object`,
 * ce qui fait échouer 100 % des appels `createEmployee`
 * (`/department: expected object, but got string`).
 * Le schéma DOIT rester plat : `{ type: 'string', enum: [...] }`.
 * Verrouillé par `tests/unit/tools/tool-schema-flatness.test.ts`.
 *
 * Le `.trim()` est déplacé en `preprocess` (avant validation) et la sanitization
 * `sanitizeText` reste en `transform` (après validation) : comportement identique
 * à l'ancienne chaîne. Les bornes `min(2)/max(100)` sont supprimées car l'enum est
 * une allowlist stricte — strictement plus restrictive que la contrainte de longueur.
 */
export const departmentSchema = z
  .preprocess(
    trimIfString,
    z.nativeEnum(Department, {
      errorMap: () => ({ message: 'Department must be one of the allowed values' }),
    }),
  )
  .transform(sanitizeText)
  .describe('Employee department');

/**
 * Poste / Position — **champ libre**, contrairement à `departmentSchema`.
 *
 * L'ancienne allowlist (`z.nativeEnum(Position)`, 24 valeurs) ne contenait pas
 * « Software Engineer », le titre le plus répandu du métier : elle rejetait des
 * saisies parfaitement légitimes. Un poste est un intitulé rédigé par la
 * personne, pas une taxonomie RH — au contraire du département, qui pilote le
 * routage vers les canaux Slack et reste donc une allowlist.
 *
 * L'enum `Position` survit comme liste de suggestions ; la colonne SQL est
 * `text NOT NULL` sans contrainte CHECK, donc la bascule n'exige aucune
 * migration. Effet de bord recherché : les 24 valeurs ne sont plus réinjectées
 * dans le schéma JSON du tool à chaque aller-retour, ce qui allège le budget
 * face au plafond Groq de 12 000 tokens/minute.
 *
 * ⚠️ Même contrainte que `departmentSchema` : schéma plat obligatoire, pas de
 * `.pipe()` — la sérialisation doit rester un `{"type":"string", …}` sans
 * `allOf`. Verrouillé par `tool-schema-flatness.test.ts`.
 */
export const positionSchema = z
  .preprocess(
    trimIfString,
    z
      .string()
      .min(
        VALIDATION_CONSTRAINTS.POSITION.MIN_LENGTH,
        `Position must be at least ${VALIDATION_CONSTRAINTS.POSITION.MIN_LENGTH} characters`,
      )
      .max(
        VALIDATION_CONSTRAINTS.POSITION.MAX_LENGTH,
        `Position must not exceed ${VALIDATION_CONSTRAINTS.POSITION.MAX_LENGTH} characters`,
      )
      .regex(VALIDATION_CONSTRAINTS.POSITION.PATTERN, VALIDATION_CONSTRAINTS.POSITION.MESSAGE),
  )
  .transform(sanitizeText)
  .describe('Employee position (free text, e.g. "Software Engineer")');

/**
 * Date de début avec contraintes métier
 */
export const startDateSchema = z
  .string()
  .refine((val) => !isNaN(Date.parse(val)), { message: 'Invalid date format' })
  .refine(
    (val) => {
      const date = new Date(val);
      const minDate = new Date(VALIDATION_CONSTRAINTS.START_DATE.MIN_YEAR, 0, 1);
      const maxDate = new Date();
      maxDate.setDate(maxDate.getDate() + VALIDATION_CONSTRAINTS.START_DATE.MAX_FUTURE_DAYS);
      return date >= minDate && date <= maxDate;
    },
    {
      message: `Start date must be between ${VALIDATION_CONSTRAINTS.START_DATE.MIN_YEAR} and ${VALIDATION_CONSTRAINTS.START_DATE.MAX_FUTURE_DAYS} days from now`,
    },
  )
  .transform((val) => new Date(val).toISOString())
  .describe('Start date (ISO 8601)');

/**
 * Date d'échéance avec contraintes métier
 */
export const dueDateSchema = z
  .string()
  .datetime({ message: 'Invalid datetime format' })
  .refine(
    (val) => {
      const dueDate = new Date(val);
      const now = new Date();
      const minDate = new Date(now);
      minDate.setDate(minDate.getDate() + VALIDATION_CONSTRAINTS.DUE_DATE.MIN_DAYS_FROM_NOW);
      const maxDate = new Date(now);
      maxDate.setDate(maxDate.getDate() + VALIDATION_CONSTRAINTS.DUE_DATE.MAX_DAYS_FROM_NOW);
      return dueDate >= minDate && dueDate <= maxDate;
    },
    {
      message: `Due date must be between today and ${VALIDATION_CONSTRAINTS.DUE_DATE.MAX_DAYS_FROM_NOW} days from now`,
    },
  )
  .nullable()
  .optional()
  .describe('Due date (ISO 8601 datetime)');

/**
 * Timestamps (createdAt, updatedAt, deletedAt)
 */
export const timestampsSchema = z
  .object({
    createdAt: z.string().datetime({ message: 'Invalid created datetime' }),
    updatedAt: z.string().datetime({ message: 'Invalid updated datetime' }),
    deletedAt: z.string().datetime().nullable().optional(),
  })
  .describe('Record timestamps');

/**
 * Pagination
 */
export const paginationSchema = z
  .object({
    page: z.coerce
      .number()
      .int('Page must be an integer')
      .min(1, 'Page must be at least 1')
      .default(VALIDATION_CONSTRAINTS.PAGINATION.DEFAULT_PAGE)
      .describe('Page number'),
    limit: z.coerce
      .number()
      .int('Limit must be an integer')
      .min(1, 'Limit must be at least 1')
      .max(
        VALIDATION_CONSTRAINTS.PAGINATION.MAX_LIMIT,
        `Limit must not exceed ${VALIDATION_CONSTRAINTS.PAGINATION.MAX_LIMIT}`,
      )
      .default(VALIDATION_CONSTRAINTS.PAGINATION.DEFAULT_LIMIT)
      .describe('Items per page'),
    sortBy: z.string().optional().describe('Field to sort by'),
    sortOrder: z.enum(['asc', 'desc']).default('asc').describe('Sort order'),
  })
  .describe('Pagination parameters');

// ============================================
// ⚠️ SECTIONS 4 À 12 SUPPRIMÉES LE 2026-08-17
// ============================================
//
// Ce fichier faisait 849 lignes pour SEPT symboles réellement importés :
// `uuidSchema`, `emailSchema`, `timestampsSchema`, `departmentSchema`, `positionSchema`,
// `VALIDATION_CONSTRAINTS` et `sanitizeText` (relevé sur les 13 sites d'import du dépôt).
//
// Tout le reste était une COUCHE DTO PARALLÈLE que rien ne consommait : schémas de
// `task` et de `questionnaire` — deux features supprimées du dépôt le 2026-08-14, dont
// les schémas ont survécu au retrait —, DTO de notification et de document doublonnant
// ceux que les features déclarent elles-mêmes, filtres de recherche et pagination sans
// aucun appelant, et un `validateStatusTransition` qui arbitrait des transitions
// d'entités dont deux n'existent plus.
//
// S'y trouvaient aussi les schémas d'employé, morts EUX AUSSI ici : le dépôt utilise
// ceux de `features/employee/application/dtos/employee.dto.ts`, et aucun importateur de
// ce module ne demandait `createEmployeeSchema`, `employeeDtoSchema` ni
// `updateEmployeeSchema`. Deux définitions du même contrat, dont une seule vivante :
// c'est la configuration qui fait qu'on corrige la mauvaise.
//
// La suppression est purement soustractive — aucun symbole conservé n'a changé, ce que
// le typecheck et les 1 597 tests vérifient.

// Schémas de base
export { VALIDATION_CONSTRAINTS, sanitizeText };

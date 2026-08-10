// ============================================
// shared/validation/index.ts - Centralized Validation Schemas
// Standards 2026: Zod + Domain-Driven + Anti-XSS
// ============================================

import { z } from 'zod';
import { sanitizeHtml, sanitizeRichHtml } from './security/html-sanitizer.js';
import validator from 'validator';
import {
  EmployeeStatus,
  TaskStatus,
  TaskType,
  TaskPriority,
  QuestionnaireStatus,
  ResponseStatus,
  DocumentType,
  DocumentFormat,
  DocumentStatus,
  NotificationChannel,
  NotificationStatus,
  RecipientType,
  OnboardingStatus,
  Department,
  Position,
} from './types.js';

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
  return sanitizeHtml(value.trim())
    .replace(/<[^>]*>/g, '') // Supprime tout HTML résiduel
    .replace(/[^a-zA-ZÀ-ÿ\s'-]/g, '') // Garde uniquement les caractères autorisés
    .replace(/\s+/g, ' ') // Normalise les espaces
    .trim();
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
  .refine((email) => validator.isEmail(email, { allow_utf8_local_part: false }), {
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
 * Poste / Position
 *
 * ⚠️ Même contrainte que `departmentSchema` : schéma plat obligatoire, pas de `.pipe()`.
 */
export const positionSchema = z
  .preprocess(
    trimIfString,
    z.nativeEnum(Position, {
      errorMap: () => ({ message: 'Position must be one of the allowed values' }),
    }),
  )
  .transform(sanitizeText)
  .describe('Employee position');

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
// 4. SCHÉMAS MÉTIER (Domain Entities)
// ============================================

/**
 * Question dans un questionnaire
 */
export const questionSchema = z
  .object({
    id: z.string().min(1, 'Question ID is required'),
    type: z.enum(['text', 'choice', 'multiple_choice', 'scale', 'boolean', 'date', 'file_upload'], {
      errorMap: () => ({ message: 'Invalid question type' }),
    }),
    label: z.string().min(1, 'Question label is required').max(500).transform(sanitizeText),
    description: z.string().max(1000).transform(sanitizeRichText).optional(),
    required: z.boolean().default(false),
    // Options pour choice/multiple_choice
    options: z
      .array(z.string().min(1).max(200).transform(sanitizeText))
      .min(1, 'At least one option is required')
      .max(50, 'Maximum 50 options allowed')
      .optional()
      .describe('Available options for choice questions'),
    // Pour scale
    min: z.number().int().optional().describe('Minimum scale value'),
    max: z.number().int().optional().describe('Maximum scale value'),
    // Ordre d'affichage
    order: z.number().int().min(0).default(0),
  })
  .refine(
    (data) => {
      // Validation conditionnelle : options requises pour choice/multiple_choice
      if (['choice', 'multiple_choice'].includes(data.type) && !data.options) {
        return false;
      }
      return true;
    },
    {
      message: 'Options are required for choice/multiple_choice question types',
      path: ['options'],
    },
  )
  .refine(
    (data) => {
      // Validation conditionnelle : min/max requis pour scale
      if (data.type === 'scale' && (data.min === undefined || data.max === undefined)) {
        return false;
      }
      return true;
    },
    {
      message: 'Min and max are required for scale question type',
      path: ['min'],
    },
  )
  .refine(
    (data) => {
      // min doit être < max
      if (data.type === 'scale' && data.min !== undefined && data.max !== undefined) {
        return data.min < data.max;
      }
      return true;
    },
    {
      message: 'Min must be less than max',
      path: ['max'],
    },
  )
  .describe('Questionnaire question');

/**
 * Employé (création)
 */
const createEmployeeBaseSchema = z.object({
  firstName: makeNameSchema().describe('Employee first name'),
  lastName: makeNameSchema().describe('Employee last name'),
  email: emailSchema.describe('Professional email'),
  department: departmentSchema.describe('Department'),
  position: positionSchema.describe('Job position'),
  startDate: startDateSchema.describe('Employment start date'),
  managerId: uuidSchema.nullable().optional().describe('Direct manager ID'),
  status: z
    .nativeEnum(EmployeeStatus)
    .default(EmployeeStatus.Pending)
    .describe('Employment status'),
  onboardingStatus: z
    .nativeEnum(OnboardingStatus)
    .default(OnboardingStatus.NotStarted)
    .describe('Onboarding progress'),
  phone: z
    .string()
    .regex(/^\+?[\d\s\-()]{7,20}$/, 'Invalid phone number')
    .optional(),
  emergencyContact: z
    .object({
      name: makeNameSchema(),
      phone: z.string().regex(/^\+?[\d\s\-()]{7,20}$/, 'Invalid phone number'),
      relationship: z.string().min(2).max(50).transform(sanitizeText),
    })
    .optional(),
});

export const createEmployeeSchema = createEmployeeBaseSchema.refine(
  (data) => {
    // Un employé actif doit avoir un manager
    if (data.status === EmployeeStatus.Active && !data.managerId) {
      return false;
    }
    return true;
  },
  {
    message: 'Active employees must have a manager',
    path: ['managerId'],
  },
);

/**
 * Employé (réponse API / DTO)
 */
export const employeeDtoSchema = createEmployeeBaseSchema
  .extend({
    id: uuidSchema,
    fullName: z.string().optional(), // Computed field
  })
  .merge(timestampsSchema);

/**
 * Employé (mise à jour - tous les champs optionnels)
 */
export const updateEmployeeSchema = createEmployeeBaseSchema.partial().extend({
  id: uuidSchema,
});

/**
 * Tâche (création)
 */
const createTaskBaseSchema = z.object({
  title: titleSchema.describe('Task title'),
  description: descriptionSchema.describe('Task description'),
  type: z.nativeEnum(TaskType, { errorMap: () => ({ message: 'Invalid task type' }) }),
  status: z.nativeEnum(TaskStatus).default(TaskStatus.Pending),
  priority: z.nativeEnum(TaskPriority).default(TaskPriority.Medium),
  dueDate: dueDateSchema,
  employeeId: uuidSchema.describe('Assigned employee'),
  assigneeId: uuidSchema.optional().describe('Specific assignee'),
  tags: z.array(z.string().max(50).transform(sanitizeText)).max(10).default([]),
  estimatedHours: z.number().min(0.5).max(160).optional(),
});

export const createTaskSchema = createTaskBaseSchema.refine(
  (data) => {
    // Une tâche complétée doit avoir une dueDate
    if (data.status === TaskStatus.Completed && !data.dueDate) {
      return false;
    }
    return true;
  },
  {
    message: 'Completed tasks must have a due date',
    path: ['dueDate'],
  },
);

/**
 * Tâche (réponse API / DTO)
 */
export const taskDtoSchema = createTaskBaseSchema
  .extend({
    id: uuidSchema,
    completedAt: z.string().datetime().nullable().optional(),
    isOverdue: z.boolean().optional(), // Computed field
  })
  .merge(timestampsSchema);

/**
 * Tâche (mise à jour)
 */
export const updateTaskSchema = createTaskBaseSchema.partial().extend({
  id: uuidSchema,
  completedAt: z.string().datetime().nullable().optional(),
});

// ============================================
// 5. SCHÉMAS DE NOTIFICATION
// ============================================

/**
 * Notification (création)
 */
const createNotificationBaseSchema = z.object({
  recipientId: uuidSchema.describe('Recipient user/employee ID'),
  recipientType: z.nativeEnum(RecipientType),
  channel: z.nativeEnum(NotificationChannel),
  subject: z.string().min(1, 'Subject is required').max(200).transform(sanitizeText),
  body: z.string().min(1, 'Body is required').max(10000).transform(sanitizeRichText),
  status: z.nativeEnum(NotificationStatus).default(NotificationStatus.Pending),
  scheduledAt: z.string().datetime().nullable().optional(),
  templateId: uuidSchema.optional().describe('Notification template ID'),
  templateData: z.record(z.string(), z.unknown()).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
});

export const createNotificationSchema = createNotificationBaseSchema.refine(
  (data) => {
    // Si scheduledAt est défini, il doit être dans le futur
    if (data.scheduledAt) {
      return new Date(data.scheduledAt) > new Date();
    }
    return true;
  },
  {
    message: 'Scheduled date must be in the future',
    path: ['scheduledAt'],
  },
);

/**
 * Notification (réponse API / DTO)
 */
export const notificationDtoSchema = createNotificationBaseSchema
  .extend({
    id: uuidSchema,
    sentAt: z.string().datetime().nullable().optional(),
    deliveredAt: z.string().datetime().nullable().optional(),
    readAt: z.string().datetime().nullable().optional(),
    errorMessage: z.string().nullable().optional(),
    retryCount: z.number().int().min(0).default(0),
  })
  .merge(timestampsSchema);

// ============================================
// 6. SCHÉMA DE QUESTIONNAIRE
// ============================================

/**
 * Questionnaire (création)
 */
const createQuestionnaireBaseSchema = z.object({
  employeeId: uuidSchema.describe('Target employee'),
  title: titleSchema.describe('Questionnaire title'),
  description: descriptionSchema.describe('Questionnaire description'),
  type: z.enum(['onboarding', 'feedback', 'evaluation', 'exit', 'custom']),
  status: z.nativeEnum(QuestionnaireStatus).default(QuestionnaireStatus.Draft),
  questions: z
    .array(questionSchema)
    .min(1, 'At least one question is required')
    .max(100, 'Maximum 100 questions allowed'),
  dueDate: dueDateSchema,
  assignedBy: uuidSchema.optional().describe('Admin/HR who assigned'),
  category: z.string().max(100).transform(sanitizeText).optional(),
  tags: z.array(z.string().max(50)).max(10).default([]),
  isAnonymous: z.boolean().default(false),
});

export const createQuestionnaireSchema = createQuestionnaireBaseSchema
  .refine(
    (data) => {
      // Vérifier que les questions ont des order uniques
      const orders = data.questions.map((q) => q.order);
      return new Set(orders).size === orders.length;
    },
    {
      message: 'Question orders must be unique',
      path: ['questions'],
    },
  )
  .refine(
    (data) => {
      // Un questionnaire publié doit avoir une dueDate
      if (data.status === QuestionnaireStatus.Published && !data.dueDate) {
        return false;
      }
      return true;
    },
    {
      message: 'Published questionnaires must have a due date',
      path: ['dueDate'],
    },
  );

/**
 * Questionnaire (réponse API / DTO)
 */
export const questionnaireDtoSchema = createQuestionnaireBaseSchema
  .extend({
    id: uuidSchema,
    responseCount: z.number().int().min(0).default(0),
    completionRate: z.number().min(0).max(100).optional(),
  })
  .merge(timestampsSchema);

// ============================================
// 7. SCHÉMAS DE RÉPONSE AU QUESTIONNAIRE
// ============================================

/**
 * Réponse à une question
 */
export const questionResponseSchema = z.object({
  questionId: z.string().min(1),
  value: z.union([z.string(), z.array(z.string()), z.number(), z.boolean()]).optional(),
  skipped: z.boolean().default(false),
});

/**
 * Réponse au questionnaire (soumission)
 */
export const submitQuestionnaireResponseSchema = z.object({
  questionnaireId: uuidSchema,
  employeeId: uuidSchema,
  responses: z.array(questionResponseSchema).min(1, 'At least one response is required'),
  submittedAt: z
    .string()
    .datetime()
    .default(() => new Date().toISOString()),
  timeSpentSeconds: z.number().int().min(0).optional(),
  completionStatus: z.nativeEnum(ResponseStatus).default(ResponseStatus.Reviewed),
});

// ============================================
// 8. SCHÉMAS DE DOCUMENT
// ============================================

/**
 * Document (création)
 */
export const createDocumentSchema = z.object({
  employeeId: uuidSchema.describe('Associated employee'),
  type: z.nativeEnum(DocumentType),
  format: z.nativeEnum(DocumentFormat),
  title: titleSchema.describe('Document title'),
  description: descriptionSchema.describe('Document description'),
  fileName: z
    .string()
    .min(1)
    .max(255)
    .refine((name) => !/[<>:"/\\|?*]/.test(name), 'File name contains invalid characters'),
  fileSize: z
    .number()
    .int()
    .positive()
    .max(50 * 1024 * 1024, 'File size exceeds 50MB'), // 50MB max
  mimeType: z.string().min(1).max(100),
  storageKey: z.string().min(1).max(500),
  status: z.nativeEnum(DocumentStatus).default(DocumentStatus.Pending),
  tags: z.array(z.string().max(50)).max(10).default([]),
  expiryDate: z.string().datetime().nullable().optional(),
  isConfidential: z.boolean().default(false),
  version: z.number().int().min(1).default(1),
});

/**
 * Document (réponse API / DTO)
 */
export const documentDtoSchema = createDocumentSchema
  .extend({
    id: uuidSchema,
    downloadUrl: z.string().url().optional(),
    uploadedBy: uuidSchema.optional(),
    verifiedAt: z.string().datetime().nullable().optional(),
  })
  .merge(timestampsSchema);

// ============================================
// 9. SCHÉMAS DE RECHERCHE ET FILTRES
// ============================================

/**
 * Filtres de recherche d'employés
 */
export const employeeSearchFiltersSchema = z
  .object({
    search: z.string().max(200).optional().describe('Full-text search query'),
    department: z.nativeEnum(Department).optional(),
    status: z.nativeEnum(EmployeeStatus).optional(),
    onboardingStatus: z.nativeEnum(OnboardingStatus).optional(),
    startDateFrom: z.string().datetime().optional(),
    startDateTo: z.string().datetime().optional(),
    managerId: uuidSchema.optional(),
    tags: z.array(z.string()).optional(),
  })
  .merge(paginationSchema);

/**
 * Filtres de recherche de tâches
 */
export const taskSearchFiltersSchema = z
  .object({
    search: z.string().max(200).optional(),
    type: z.nativeEnum(TaskType).optional(),
    status: z.nativeEnum(TaskStatus).optional(),
    priority: z.nativeEnum(TaskPriority).optional(),
    employeeId: uuidSchema.optional(),
    assigneeId: uuidSchema.optional(),
    dueDateFrom: z.string().datetime().optional(),
    dueDateTo: z.string().datetime().optional(),
    tags: z.array(z.string()).optional(),
  })
  .merge(paginationSchema);

// ============================================
// 10. VALIDATEUR DE TRANSITIONS D'ÉTAT
// ============================================

/**
 * Transitions valides entre statuts
 */
const VALID_TRANSITIONS: Record<string, string[]> = {
  // Tâches
  [`task_${TaskStatus.Pending}`]: [TaskStatus.InProgress, TaskStatus.Cancelled],
  [`task_${TaskStatus.InProgress}`]: [
    TaskStatus.Completed,
    TaskStatus.Blocked,
    TaskStatus.Cancelled,
  ],
  [`task_${TaskStatus.Blocked}`]: [TaskStatus.InProgress, TaskStatus.Cancelled],
  [`task_${TaskStatus.Completed}`]: [], // État final
  [`task_${TaskStatus.Cancelled}`]: [], // État final

  // Questionnaires
  [`questionnaire_${QuestionnaireStatus.Draft}`]: [
    QuestionnaireStatus.Published,
    QuestionnaireStatus.Archived,
  ],
  [`questionnaire_${QuestionnaireStatus.Published}`]: [
    QuestionnaireStatus.Closed,
    QuestionnaireStatus.Archived,
  ],
  [`questionnaire_${QuestionnaireStatus.Closed}`]: [QuestionnaireStatus.Archived],
  [`questionnaire_${QuestionnaireStatus.Archived}`]: [],

  // Employés
  [`employee_${EmployeeStatus.Pending}`]: [EmployeeStatus.Active, EmployeeStatus.Inactive],
  [`employee_${EmployeeStatus.Active}`]: [EmployeeStatus.Inactive, EmployeeStatus.Suspended],
  [`employee_${EmployeeStatus.Inactive}`]: [EmployeeStatus.Active],
  [`employee_${EmployeeStatus.Suspended}`]: [EmployeeStatus.Active, EmployeeStatus.Terminated],
};

/**
 * Valide une transition d'état
 */
export function validateStatusTransition(
  entityType: 'task' | 'questionnaire' | 'employee',
  fromStatus: string,
  toStatus: string,
): boolean {
  const key = `${entityType}_${fromStatus}`;
  const allowedTransitions = VALID_TRANSITIONS[key];

  if (!allowedTransitions) {
    return false;
  }

  return allowedTransitions.includes(toStatus);
}

// ============================================
// 11. TYPES INFÉRÉS
// ============================================

export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;
export type EmployeeDto = z.infer<typeof employeeDtoSchema>;

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type TaskDto = z.infer<typeof taskDtoSchema>;

export type CreateQuestionnaireInput = z.infer<typeof createQuestionnaireSchema>;
export type QuestionnaireDto = z.infer<typeof questionnaireDtoSchema>;
export type SubmitQuestionnaireResponse = z.infer<typeof submitQuestionnaireResponseSchema>;

export type CreateNotificationInput = z.infer<typeof createNotificationSchema>;
export type NotificationDto = z.infer<typeof notificationDtoSchema>;

export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;
export type DocumentDto = z.infer<typeof documentDtoSchema>;

export type EmployeeSearchFilters = z.infer<typeof employeeSearchFiltersSchema>;
export type TaskSearchFilters = z.infer<typeof taskSearchFiltersSchema>;
export type PaginationParams = z.infer<typeof paginationSchema>;

// ============================================
// 12. EXPORTS GROUPÉS
// ============================================

// Schémas de base
export { VALIDATION_CONSTRAINTS, VALID_TRANSITIONS, sanitizeText, sanitizeRichText, sanitizeName };

// Schémas legacy pour rétrocompatibilité
export const employeeSchema = createEmployeeSchema;
export const taskSchema = createTaskSchema;
export const notificationSchema = createNotificationSchema;
export const questionnaireSchema = createQuestionnaireSchema;

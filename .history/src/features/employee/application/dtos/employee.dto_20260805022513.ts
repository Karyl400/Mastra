// employee.validation.ts
import { z } from 'zod';
import validator from 'validator';
import DOMPurify from 'isomorphic-dompurify';
import { EmployeeStatus, Department, Position } from '../../../../shared/types';
import { emailSchema, timestampsSchema, uuidSchema } from '../../../../shared/validation';

// ============================================
// 1. CONSTANTES ET CONFIGURATION
// ============================================

const EMPLOYEE_CONSTRAINTS = {
  NAME: {
    MIN_LENGTH: 1,
    MAX_LENGTH: 100,
    PATTERN: /^[\p{L}\p{M}'\-\s]+$/u, // Support Unicode pour noms internationaux
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
  .transform((val) => DOMPurify.sanitize(val)) // Protection XSS
  .refine(
    (val) => !validator.contains(val, '<script>', { ignoreCase: true }),
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
  .transform((val) => DOMPurify.sanitize(val));

// ============================================
// 3. SCHEMAS MÉTIER COMPLEXES
// ============================================

/**
 * Validation de cohérence manager/employé
 */
const managerValidationSchema = z
  .object({
    managerId: uuidSchema.nullable().optional(),
    status: z.nativeEnum(EmployeeStatus),
  })
  .refine(
    (data) => {
      // Un employé actif doit avoir un manager
      if (data.status === EmployeeStatus.Active && !data.managerId) {
        return false;
      }
      return true;
    },
    {
      message: 'Active employees must have a manager assigned',
      path: ['managerId'],
    },
  )
  .refine(
    (data) => {
      // Un employé en attente ne peut pas avoir de manager
      if (data.status === EmployeeStatus.Pending && data.managerId) {
        return false;
      }
      return true;
    },
    {
      message: 'Pending employees cannot have a manager assigned',
      path: ['managerId'],
    },
  );

// ============================================
// 4. SCHEMA PRINCIPAL AVEC DISCRIMINATED UNIONS
// ============================================

/**
 * Schema de base commun à tous les employés
 */
const baseEmployeeSchema = z.object({
  firstName: nameSchema,
  lastName: nameSchema,
  email: emailSchema.refine(
    (email) => {
      // Validation asynchrone optionnelle : vérifier si l'email existe déjà
      // return await checkEmailUniqueness(email);
      return true;
    },
    { message: 'Email already exists in the system' },
  ),
  department: departmentSchema,
  position: z
    .string()
    .trim()
    .min(EMPLOYEE_CONSTRAINTS.POSITION.MIN_LENGTH)
    .max(EMPLOYEE_CONSTRAINTS.POSITION.MAX_LENGTH)
    .pipe(z.nativeEnum(Position))
    .transform((val) => DOMPurify.sanitize(val)),
  startDate: startDateSchema,
  status: z.nativeEnum(EmployeeStatus).default(EmployeeStatus.Pending),
});

/**
 * Schema objet sans les validations globales (pour réutilisation)
 */
const employeeObjectSchema = baseEmployeeSchema.extend({
  // Champs additionnels pour la création
  emergencyContact: z
    .object({
      phone: z.string().min(10).max(20).optional(),
      name: z.string().min(1).max(100),
      relationship: z.string().min(2).max(50),
    })
    .optional(),

  salary: z
    .object({
      amount: z.number().min(EMPLOYEE_CONSTRAINTS.SALARY.MIN).max(EMPLOYEE_CONSTRAINTS.SALARY.MAX),
      currency: z.string().length(3).default('EUR'),
    })
    .optional(),

  documents: z
    .array(
      z.object({
        name: z.string().min(1).max(255),
        url: z.string().url(),
        type: z.enum(['contract', 'id', 'certification', 'other']),
      }),
    )
    .max(10)
    .optional(),

  managerId: uuidSchema.nullable().optional(),
});

const applyManagerValidation = <T extends z.ZodTypeAny>(schema: T) => {
  return schema
    .refine(
      (data: { status?: string; managerId?: string | null }) => {
        if (data.status === EmployeeStatus.Active && !data.managerId) {
          return false;
        }
        return true;
      },
      {
        message: 'Active employees must have a manager assigned',
        path: ['managerId'],
      },
    )
    .refine(
      (data: { status?: string; managerId?: string | null }) => {
        if (data.status === EmployeeStatus.Pending && data.managerId) {
          return false;
        }
        return true;
      },
      {
        message: 'Pending employees cannot have a manager assigned',
        path: ['managerId'],
      },
    );
};

/**
 * Schema complet avec extension pour création
 */
export const createEmployeeSchema = applyManagerValidation(employeeObjectSchema);

/**
 * Schema pour la mise à jour (tous les champs optionnels)
 */
export const updateEmployeeSchema = applyManagerValidation(
  employeeObjectSchema.partial().extend({
    id: uuidSchema, // ID obligatoire pour la mise à jour
  }),
);

/**
 * Schema pour la réponse (DTO)
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

export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;
export type EmployeeDto = z.infer<typeof employeeDtoSchema>;

// Types pour les réponses paginées
export type EmployeeListResponse = {
  data: EmployeeDto[];
  total: number;
  page: number;
  pageSize: number;
};

// ============================================
// 6. MIDDLEWARE DE VALIDATION
// ============================================

/**
 * Middleware de validation avec transformation et sanitization
 */
export class EmployeeValidator {
  /**
   * Valide les données de création d'employé
   */
  static async validateCreate(data: unknown): Promise<CreateEmployeeInput> {
    try {
      const validated = await createEmployeeSchema.parseAsync(data);
      return validated;
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new EmployeeValidationError('Invalid employee creation data', error.errors);
      }
      throw error;
    }
  }

  /**
   * Valide les données de mise à jour
   */
  static async validateUpdate(data: unknown): Promise<UpdateEmployeeInput> {
    try {
      const validated = await updateEmployeeSchema.parseAsync(data);
      return validated;
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new EmployeeValidationError('Invalid employee update data', error.errors);
      }
      throw error;
    }
  }

  /**
   * Sanitize les données pour la réponse API
   */
  static sanitizeResponse(employee: EmployeeDto): EmployeeDto {
    // Ne jamais exposer de données sensibles
    const { ...safe } = employee;
    return employeeDtoSchema.parse(safe);
  }
}

// ============================================
// 7. GESTION D'ERREURS PERSONNALISÉE
// ============================================

export class EmployeeValidationError extends Error {
  public readonly code = 'EMPLOYEE_VALIDATION_ERROR';
  public readonly statusCode = 422;

  constructor(
    message: string,
    public readonly details: z.ZodIssue[],
  ) {
    super(message);
    this.name = 'EmployeeValidationError';

    // Capture du stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, EmployeeValidationError);
    }
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details.map((detail) => ({
          field: detail.path.join('.'),
          message: detail.message,
          code: detail.code,
        })),
      },
    };
  }
}

// ============================================
// 8. HOOKS DE PRÉ/POST VALIDATION
// ============================================

/**
 * Transformations avant validation
 */
export const preValidationHooks = {
  /**
   * Normalise les données avant validation
   */
  normalizeData(data: Record<string, unknown>): Record<string, unknown> {
    const normalized = { ...data };

    // Normalisation email : lowercase
    if (typeof normalized.email === 'string') {
      normalized.email = normalized.email.toLowerCase().trim();
    }

    // Normalisation noms : capitalisation
    if (typeof normalized.firstName === 'string') {
      normalized.firstName = this.capitalize(normalized.firstName);
    }
    if (typeof normalized.lastName === 'string') {
      normalized.lastName = this.capitalize(normalized.lastName);
    }

    return normalized;
  },

  capitalize(str: string): string {
    return str
      .split(/[\s-']/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(str.includes('-') ? '-' : str.includes("'") ? "'" : ' ');
  },
};

// ============================================
// 9. TESTS DE VALIDATION (INTÉGRÉS)
// ============================================

/**
 * Test cases pour la validation
 */
export const validationTestCases = {
  valid: {
    minimal: {
      firstName: 'John',
      lastName: 'Doe',
      email: 'john.doe@company.com',
      department: Department.Engineering,
      position: Position.SeniorDeveloper,
      startDate: new Date().toISOString(),
      status: EmployeeStatus.Active,
      managerId: '123e4567-e89b-12d3-a456-426614174000',
    },
    complete: {
      firstName: 'Jane',
      lastName: "O'Connor-Smith",
      email: 'jane.oconnor@company.com',
      department: Department.Marketing,
      position: Position.Director,
      startDate: '2024-01-15T00:00:00Z',
      status: EmployeeStatus.Active,
      managerId: '123e4567-e89b-12d3-a456-426614174000',
      emergencyContact: {
        name: 'John Smith',
        phone: '+33123456789',
        relationship: 'Spouse',
      },
      salary: {
        amount: 75000,
        currency: 'EUR',
      },
    },
  },
  invalid: {
    xssAttempt: {
      firstName: '<script>alert("xss")</script>',
      lastName: 'Doe',
      email: 'test@test.com',
      department: Department.Engineering,
      position: Position.BackendDeveloper,
      startDate: new Date().toISOString(),
    },
    futureDate: {
      firstName: 'John',
      lastName: 'Doe',
      email: 'john@test.com',
      department: Department.Engineering,
      position: Position.BackendDeveloper,
      startDate: '2099-01-01T00:00:00Z',
    },
    noManager: {
      firstName: 'John',
      lastName: 'Doe',
      email: 'john@test.com',
      department: Department.Engineering,
      position: Position.BackendDeveloper,
      startDate: new Date().toISOString(),
      status: EmployeeStatus.Active,
      // Pas de managerId alors que status = Active
    },
  },
};

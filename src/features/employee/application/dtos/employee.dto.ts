import { z } from 'zod';
import contains from 'validator/lib/contains.js';
import { sanitizeHtml } from '../../../../shared/security/html-sanitizer.js';
import { EmployeeStatus, Department } from '../../../../shared/types';
import { emailSchema, timestampsSchema, uuidSchema } from '../../../../shared/validation';

const EMPLOYEE_CONSTRAINTS = {
  NAME: {
    MIN_LENGTH: 1,
    MAX_LENGTH: 100,
    PATTERN: /^[a-zA-ZÀ-ÿ\s'-]+$/,
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
    MAX_FUTURE_DAYS: 90,
  },
  SALARY: {
    MIN: 0,
    MAX: 1_000_000_000,
  },
} as const;

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
  .transform((val) => sanitizeHtml(val))
  .refine(
    (val) => !contains(val, '<script>', { ignoreCase: true }),
    'Name contains potentially unsafe content',
  );

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
  .transform((date) => new Date(date).toISOString());

const departmentSchema = z
  .string()
  .trim()
  .min(EMPLOYEE_CONSTRAINTS.DEPARTMENT.MIN_LENGTH)
  .max(EMPLOYEE_CONSTRAINTS.DEPARTMENT.MAX_LENGTH)
  .pipe(z.nativeEnum(Department))
  .transform((val) => sanitizeHtml(val));

const baseEmployeeSchema = z.object({
  firstName: nameSchema,
  lastName: nameSchema,
  email: emailSchema,
  department: departmentSchema.nullable(),
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

export const employeeDtoSchema = applyManagerValidation(
  baseEmployeeSchema
    .extend({
      id: uuidSchema,
      managerId: uuidSchema.nullable().optional(),

      fullName: z.string().optional(),
      tenure: z.number().optional(),
    })
    .merge(timestampsSchema),
);

export type EmployeeDto = z.infer<typeof employeeDtoSchema>;

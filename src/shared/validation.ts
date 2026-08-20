import { z } from 'zod';
import { sanitizeHtml, sanitizeRichHtml } from './security/html-sanitizer.js';
import isEmail from 'validator/lib/isEmail.js';
import { Department } from './types.js';

const VALIDATION_CONSTRAINTS = {
  NAME: {
    MIN_LENGTH: 2,
    MAX_LENGTH: 100,
    PATTERN: /^[a-zA-ZÀ-ÿ\s'-]+$/,
    MESSAGE: 'Name must contain only letters, accents, spaces, hyphens, and apostrophes',
  },
  POSITION: {
    MIN_LENGTH: 2,
    MAX_LENGTH: 150,
    PATTERN: /^[a-zA-ZÀ-ÿ0-9\s'&./()-]+$/,
    MESSAGE:
      'Position must contain only letters, digits, spaces and the punctuation &./()- and apostrophes',
  },
  EMAIL: {
    MAX_LENGTH: 254,
    BLOCKED_DOMAINS: ['tempmail.com', 'guerrillamail.com', '10minutemail.com'],
  },
  TITLE: {
    MIN_LENGTH: 3,
    MAX_LENGTH: 200,
    PATTERN: /^[^<>{}[\]\\]*$/,
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

function sanitizeText(value: string): string {
  return sanitizeHtml(value.trim());
}

function sanitizeRichText(value: string): string {
  return sanitizeRichHtml(value.trim());
}

function sanitizeName(value: string): string {
  return (
    sanitizeHtml(value.trim())
      // eslint-disable-next-line sonarjs/super-linear-regex
      .replace(/<[^>]*>/g, '')
      .replace(/[^a-zA-ZÀ-ÿ\s'-]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

export const uuidSchema = z
  .string()
  .uuid({ message: 'Invalid UUID format' })
  .describe('UUID v4/v7 identifier');

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

export const nameSchema = makeNameSchema();

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

export const descriptionSchema = z
  .string()
  .max(VALIDATION_CONSTRAINTS.DESCRIPTION.MAX_LENGTH, 'Description is too long')
  .transform(sanitizeRichText)
  .default('')
  .describe('Description with limited HTML formatting');

function trimIfString(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

export const departmentSchema = z
  .preprocess(
    trimIfString,
    z.nativeEnum(Department, {
      errorMap: () => ({ message: 'Department must be one of the allowed values' }),
    }),
  )
  .transform(sanitizeText)
  .describe('Employee department');

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

export const timestampsSchema = z
  .object({
    createdAt: z.string().datetime({ message: 'Invalid created datetime' }),
    updatedAt: z.string().datetime({ message: 'Invalid updated datetime' }),
    deletedAt: z.string().datetime().nullable().optional(),
  })
  .describe('Record timestamps');

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

export { VALIDATION_CONSTRAINTS, sanitizeText };

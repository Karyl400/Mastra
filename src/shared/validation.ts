import { z } from 'zod';
import { sanitizeHtml } from './security/html-sanitizer.js';
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
  START_DATE: {
    MIN_YEAR: 2000,
    MAX_FUTURE_DAYS: 90,
  },
} as const;

function sanitizeText(value: string): string {
  return sanitizeHtml(value.trim());
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

export const timestampsSchema = z
  .object({
    createdAt: z.string().datetime({ message: 'Invalid created datetime' }),
    updatedAt: z.string().datetime({ message: 'Invalid updated datetime' }),
    deletedAt: z.string().datetime().nullable().optional(),
  })
  .describe('Record timestamps');

export { VALIDATION_CONSTRAINTS, sanitizeText };

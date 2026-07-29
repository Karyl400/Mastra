import { z } from 'zod';
import { 
  EmployeeStatus, 
  TaskStatus, 
  TaskType, 
  QuestionnaireStatus, 
  ResponseStatus, 
  DocumentType, 
  DocumentFormat, 
  DocumentStatus, 
  NotificationChannel, 
  NotificationStatus, 
  RecipientType, 
  OnboardingStatus 
} from './types.js';

export const uuidSchema = z.string().uuid();

export const emailSchema = z.string().email();

export const timestampsSchema = z.object({
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable().optional(),
});

export const questionSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['text', 'choice', 'multiple_choice', 'scale', 'boolean']),
  label: z.string().min(1),
  required: z.boolean(),
  options: z.array(z.string()).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const employeeSchema = z.object({
  id: uuidSchema.optional(),
  name: z.string().min(2),
  email: emailSchema,
  role: z.string().min(2),
  department: z.string().min(2),
  startDate: z.string().datetime(),
  status: z.nativeEnum(EmployeeStatus).default(EmployeeStatus.Pending),
  onboardingStatus: z.nativeEnum(OnboardingStatus).default(OnboardingStatus.NotStarted),
});

export const taskSchema = z.object({
  id: uuidSchema.optional(),
  title: z.string().min(2),
  description: z.string().optional(),
  type: z.nativeEnum(TaskType),
  status: z.nativeEnum(TaskStatus).default(TaskStatus.Pending),
  dueDate: z.string().datetime().optional(),
  employeeId: uuidSchema,
});

export const notificationSchema = z.object({
  id: uuidSchema.optional(),
  recipientId: uuidSchema,
  recipientType: z.nativeEnum(RecipientType),
  channel: z.nativeEnum(NotificationChannel),
  subject: z.string().min(1),
  body: z.string().min(1),
  status: z.nativeEnum(NotificationStatus).default(NotificationStatus.Pending),
  scheduledAt: z.string().datetime().optional(),
});

export const questionnaireSchema = z.object({
  id: uuidSchema.optional(),
  employeeId: uuidSchema,
  type: z.string(),
  status: z.nativeEnum(QuestionnaireStatus).default(QuestionnaireStatus.Draft),
  questions: z.array(questionSchema),
});

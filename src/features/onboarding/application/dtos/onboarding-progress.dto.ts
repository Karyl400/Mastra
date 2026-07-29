import { z } from 'zod';
import { OnboardingStatus, TaskStatus } from '../../../../shared/types';
import { timestampsSchema, uuidSchema } from '../../../../shared/validation';

export const onboardingProgressDtoSchema = z.object({
  id: uuidSchema,
  employeeId: uuidSchema,
  status: z.nativeEnum(OnboardingStatus).default(OnboardingStatus.NotStarted),
  currentStep: z.number().int().min(0).default(0),
  totalSteps: z.number().int().min(0).default(0),
  startedAt: z.string().datetime().nullable().optional(),
  completedAt: z.string().datetime().nullable().optional(),
}).merge(timestampsSchema);

export type OnboardingProgressDto = z.infer<typeof onboardingProgressDtoSchema>;

export const onboardingStepDtoSchema = z.object({
  id: uuidSchema,
  progressId: uuidSchema,
  taskId: uuidSchema,
  stepOrder: z.number().int().min(0),
  status: z.nativeEnum(TaskStatus).default(TaskStatus.Pending),
  completedAt: z.string().datetime().nullable().optional(),
}).merge(timestampsSchema);

export type OnboardingStepDto = z.infer<typeof onboardingStepDtoSchema>;

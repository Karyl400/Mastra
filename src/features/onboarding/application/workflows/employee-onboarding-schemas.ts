import { z } from 'zod';
import { BestEffortStep, OnboardingOutcome } from '../../domain/value-objects/onboarding-outcome';
import { Department } from '../../../../shared/types';
import { VALIDATION_CONSTRAINTS } from '../../../../shared/validation';

export const onboardingInputSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  department: z.nativeEnum(Department).nullable().optional(),
  position: z
    .string()
    .min(VALIDATION_CONSTRAINTS.POSITION.MIN_LENGTH, 'position is too short')
    .max(VALIDATION_CONSTRAINTS.POSITION.MAX_LENGTH, 'position is too long')
    .regex(VALIDATION_CONSTRAINTS.POSITION.PATTERN, VALIDATION_CONSTRAINTS.POSITION.MESSAGE),
  startDate: z.string().datetime(),
  managerId: z.string().uuid().nullable().optional(),
  slackChannelId: z
    .string()
    .nullable()
    .optional()
    .describe('Channel Slack du département (optionnel)'),
});

export const employeeCreatedSchema = z.object({
  employeeId: z.string().uuid(),
  alreadyExisted: z.boolean(),
  email: z.string().email(),
  firstName: z.string(),
  lastName: z.string(),
  department: z.string().nullable(),
  position: z.string(),
  startDate: z.string(),
  slackChannelId: z.string().nullable().optional(),
});

export const stepFailureSchema = z.object({
  step: z.nativeEnum(BestEffortStep),
  reason: z.string(),
});

export const onboardingInitializedSchema = z.object({
  employeeId: z.string().uuid(),
  alreadyExisted: z.boolean(),
  progressId: z.string().uuid(),
  email: z.string().email(),
  firstName: z.string(),
  lastName: z.string(),
  position: z.string(),
  startDate: z.string(),
  slackChannelId: z.string().nullable().optional(),
  degraded: z.array(stepFailureSchema),
});

export const welcomeSentSchema = z.object({
  employeeId: z.string().uuid(),
  email: z.string().email(),
  firstName: z.string(),
  lastName: z.string(),
  emailSent: z.boolean(),
  slackChannelId: z.string().nullable().optional(),
  degraded: z.array(stepFailureSchema),
});

export const onboardingOutputSchema = z.object({
  employeeId: z.string().uuid(),
  outcome: z.nativeEnum(OnboardingOutcome),
  emailSent: z.boolean(),
  slackInvited: z.boolean(),
  slackUserId: z.string().optional(),
  degradedSteps: z.array(stepFailureSchema),
});

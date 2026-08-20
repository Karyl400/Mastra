import { createProgress, type OnboardingProgress } from '../entities/onboarding-progress';
import { OnboardingStatus } from '../../../../shared/types';

export const ONBOARDING_TOTAL_STEPS = 1;

export interface OnboardingPlan {
  readonly progress: OnboardingProgress;
}

export interface OnboardingPlanInput {
  readonly employeeId: string;
  readonly progressId?: string;
  readonly newId?: () => string;
}

export function buildOnboardingPlan(input: OnboardingPlanInput): OnboardingPlan {
  const newId = input.newId ?? (() => crypto.randomUUID());
  const now = new Date().toISOString();

  const base = createProgress({
    id: input.progressId ?? newId(),
    employeeId: input.employeeId,
    currentStep: ONBOARDING_TOTAL_STEPS,
    totalSteps: ONBOARDING_TOTAL_STEPS,
  });

  return {
    progress: {
      ...base,
      status: OnboardingStatus.Completed,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    },
  };
}

export function reconcileProgress(progress: OnboardingProgress): OnboardingProgress {
  const currentStep = Math.min(progress.currentStep, ONBOARDING_TOTAL_STEPS);
  const done = currentStep >= ONBOARDING_TOTAL_STEPS;
  const status = done ? OnboardingStatus.Completed : progress.status;

  const coherent =
    progress.totalSteps === ONBOARDING_TOTAL_STEPS &&
    progress.currentStep === currentStep &&
    progress.status === status;

  if (coherent) return progress;

  const now = new Date().toISOString();

  return {
    ...progress,
    currentStep,
    totalSteps: ONBOARDING_TOTAL_STEPS,
    status,
    completedAt: done ? (progress.completedAt ?? now) : progress.completedAt,
    updatedAt: now,
  };
}

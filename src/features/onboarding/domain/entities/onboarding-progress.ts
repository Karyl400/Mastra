import { OnboardingStatus, TaskStatus, type Timestamps } from '../../../../shared/types';

export interface OnboardingProgress extends Timestamps {
  readonly id: string;
  readonly employeeId: string;
  readonly status: OnboardingStatus;
  readonly currentStep: number;
  readonly totalSteps: number;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
}

export interface OnboardingStep extends Timestamps {
  readonly id: string;
  readonly progressId: string;
  readonly taskId: string;
  readonly stepOrder: number;
  readonly status: TaskStatus;
  readonly completedAt?: string | null;
}

export function createProgress(
  data: Omit<OnboardingProgress, keyof Timestamps | 'status'>,
): OnboardingProgress {
  const now = new Date().toISOString();
  return {
    ...data,
    status: OnboardingStatus.NotStarted,
    createdAt: now,
    updatedAt: now,
  };
}

export function createStep(
  data: Omit<OnboardingStep, keyof Timestamps | 'status'>,
): OnboardingStep {
  const now = new Date().toISOString();
  return {
    ...data,
    status: TaskStatus.Pending,
    createdAt: now,
    updatedAt: now,
  };
}

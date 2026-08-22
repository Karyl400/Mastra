import { OnboardingStatus, type Timestamps } from '../../../../shared/types';

export interface OnboardingProgress extends Timestamps {
  readonly id: string;
  readonly employeeId: string;
  readonly status: OnboardingStatus;
  readonly currentStep: number;
  readonly totalSteps: number;
  readonly startedAt?: string | null;
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

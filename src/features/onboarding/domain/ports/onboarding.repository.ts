import type { OnboardingProgress, OnboardingStep } from '../entities/onboarding-progress';

export interface OnboardingRepository {
  findByEmployee(employeeId: string): Promise<OnboardingProgress | null>;
  save(progress: OnboardingProgress): Promise<void>;
  update(progress: OnboardingProgress): Promise<void>;
  findSteps(progressId: string): Promise<OnboardingStep[]>;
  saveStep(step: OnboardingStep): Promise<void>;
  updateStep(step: OnboardingStep): Promise<void>;
}

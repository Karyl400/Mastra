import type { OnboardingProgress } from '../entities/onboarding-progress';

export interface OnboardingRepository {
  findByEmployee(employeeId: string): Promise<OnboardingProgress | null>;
  save(progress: OnboardingProgress): Promise<void>;
  update(progress: OnboardingProgress): Promise<number>;
}

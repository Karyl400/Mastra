import { eq } from 'drizzle-orm';
import { getDb } from '../../../../infrastructure/database/connection';
import { onboardingProgress, onboardingSteps } from '../../../../infrastructure/database/schema';
import { OnboardingProgress, OnboardingStep } from '../../domain/entities/onboarding-progress';
import { OnboardingRepository } from '../../domain/ports/onboarding.repository';

export class DrizzleOnboardingRepository implements OnboardingRepository {
  async save(progress: OnboardingProgress): Promise<void> {
    const db = getDb();
    await db.insert(onboardingProgress).values(progress).onConflictDoUpdate({
      target: onboardingProgress.id,
      set: progress,
    });
  }

  async update(progress: OnboardingProgress): Promise<void> {
    await this.save(progress);
  }

  async findByEmployee(employeeId: string): Promise<OnboardingProgress | null> {
    const db = getDb();
    const result = await db.select().from(onboardingProgress).where(eq(onboardingProgress.employeeId, employeeId)).get();
    if (!result) return null;
    return result as OnboardingProgress;
  }

  async saveStep(step: OnboardingStep): Promise<void> {
    const db = getDb();
    await db.insert(onboardingSteps).values(step).onConflictDoUpdate({
      target: onboardingSteps.id,
      set: step,
    });
  }

  async updateStep(step: OnboardingStep): Promise<void> {
    await this.saveStep(step);
  }

  async findSteps(progressId: string): Promise<OnboardingStep[]> {
    const db = getDb();
    const result = await db.select().from(onboardingSteps).where(eq(onboardingSteps.progressId, progressId));
    return result as OnboardingStep[];
  }
}

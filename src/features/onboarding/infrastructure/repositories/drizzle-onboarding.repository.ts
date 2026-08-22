import { eq } from 'drizzle-orm';
import { getDb } from '../../../../infrastructure/database/connection';
import { onboardingProgress } from '../../../../infrastructure/database/schema';
import type { OnboardingProgress } from '../../domain/entities/onboarding-progress';
import type { OnboardingRepository } from '../../domain/ports/onboarding.repository';

export class DrizzleOnboardingRepository implements OnboardingRepository {
  async save(progress: OnboardingProgress): Promise<void> {
    const db = getDb();
    await db
      .insert(onboardingProgress)
      .values({
        id: progress.id,
        employeeId: progress.employeeId,
        status: progress.status,
        currentStep: progress.currentStep,
        totalSteps: progress.totalSteps,
        startedAt: progress.startedAt ?? null,
        completedAt: progress.completedAt ?? null,
        createdAt: progress.createdAt,
        updatedAt: progress.updatedAt,
      })
      .onConflictDoUpdate({
        target: onboardingProgress.id,
        set: {
          status: progress.status,
          currentStep: progress.currentStep,
          totalSteps: progress.totalSteps,
          startedAt: progress.startedAt ?? null,
          completedAt: progress.completedAt ?? null,
          updatedAt: progress.updatedAt,
        },
      });
  }

  async update(progress: OnboardingProgress): Promise<number> {
    const db = getDb();
    const result = await db
      .update(onboardingProgress)
      .set({
        status: progress.status,
        currentStep: progress.currentStep,
        totalSteps: progress.totalSteps,
        startedAt: progress.startedAt ?? null,
        completedAt: progress.completedAt ?? null,
        updatedAt: progress.updatedAt,
      })
      .where(eq(onboardingProgress.id, progress.id));

    return (result as unknown as { rowsAffected?: number }).rowsAffected ?? 0;
  }

  async findByEmployee(employeeId: string): Promise<OnboardingProgress | null> {
    const db = getDb();
    const result = await db
      .select()
      .from(onboardingProgress)
      .where(eq(onboardingProgress.employeeId, employeeId))
      .get();
    if (!result) return null;
    return result as unknown as OnboardingProgress;
  }
}

import { eq } from 'drizzle-orm';
import { getDb } from '../../../../infrastructure/database/connection';
import { onboardingProgress, onboardingSteps } from '../../../../infrastructure/database/schema';
import type { OnboardingProgress, OnboardingStep } from '../../domain/entities/onboarding-progress';
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
        // ⚠️ `startedAt` et `updatedAt` étaient ABSENTS de ce `set` — bug mesuré en
        // production le 2026-08-12. Les valeurs sont bien passées à `.values()`, mais
        // `values()` est IGNORÉ dès qu'il y a conflit : seul le `set` s'applique. Sur une
        // ligne existante, `updated_at` restait donc gelé à la date d'insertion
        // (2026-08-11T18:02:35 en production, alors que le tool venait de tourner), et le
        // `startedAt` calculé lors de la transition `not_started → in_progress` était jeté
        // en silence. Le symptôme observé était « le bot annonce une mise à jour et rien
        // ne change en base ».
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

  /**
   * Rend le nombre de lignes RÉELLEMENT affectées.
   *
   * `Promise<void>` empêchait structurellement tout appelant de savoir si l'écriture
   * avait eu lieu : `updateOnboardingStatus` retournait `updated: true` en constante, et
   * le modèle annonçait à l'utilisateur une mise à jour qu'il ne pouvait pas vérifier.
   * Quatrième occurrence dans ce dépôt de la signature « le champ dit mieux que le fait ».
   */
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

    // libsql expose `rowsAffected` ; le `?? 0` couvre un pilote qui ne le fournirait pas,
    // auquel cas on préfère annoncer « rien de sûr » plutôt qu'un succès supposé.
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

  async saveStep(step: OnboardingStep): Promise<void> {
    const db = getDb();
    await db
      .insert(onboardingSteps)
      .values({
        id: step.id,
        progressId: step.progressId,
        taskId: step.taskId,
        name: step.taskId,
        stepOrder: step.stepOrder,
        status: step.status,
        createdAt: step.createdAt,
        updatedAt: step.updatedAt,
        completedAt: step.completedAt ?? null,
      })
      .onConflictDoUpdate({
        target: onboardingSteps.id,
        // Même défaut que `save()` ci-dessus, même correctif : `updatedAt` était absent du
        // `set`, donc gelé à l'insertion sur toute étape déjà existante.
        set: {
          status: step.status,
          completedAt: step.completedAt ?? null,
          updatedAt: step.updatedAt,
        },
      });
  }

  async updateStep(step: OnboardingStep): Promise<void> {
    await this.saveStep(step);
  }

  async findSteps(progressId: string): Promise<OnboardingStep[]> {
    const db = getDb();
    const results = await db
      .select()
      .from(onboardingSteps)
      .where(eq(onboardingSteps.progressId, progressId))
      .orderBy(onboardingSteps.stepOrder);
    return results as unknown as OnboardingStep[];
  }
}

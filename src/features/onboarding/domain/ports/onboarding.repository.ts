import type { OnboardingProgress, OnboardingStep } from '../entities/onboarding-progress';

export interface OnboardingRepository {
  findByEmployee(employeeId: string): Promise<OnboardingProgress | null>;
  save(progress: OnboardingProgress): Promise<void>;
  /**
   * Applique la mise à jour et rend le NOMBRE DE LIGNES affectées.
   *
   * Le contrat rendait `void`, donc aucun appelant ne pouvait distinguer une écriture
   * réussie d'une écriture sur zéro ligne — et `updateOnboardingStatus` annonçait au
   * modèle un `updated: true` constant, vrai par construction. Bug mesuré en production
   * le 2026-08-12 : le bot a dit « l'avancement de ton onboarding est mis à jour » alors
   * que rien n'avait bougé.
   */
  update(progress: OnboardingProgress): Promise<number>;
  findSteps(progressId: string): Promise<OnboardingStep[]>;
  saveStep(step: OnboardingStep): Promise<void>;
  updateStep(step: OnboardingStep): Promise<void>;
}

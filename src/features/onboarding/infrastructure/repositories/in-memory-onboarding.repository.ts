import type { OnboardingProgress, OnboardingStep } from '../../domain/entities/onboarding-progress';
import type { OnboardingRepository } from '../../domain/ports/onboarding.repository';

export class InMemoryOnboardingRepository implements OnboardingRepository {
  private progressStore = new Map<string, OnboardingProgress>();
  private stepStore = new Map<string, OnboardingStep>();

  async findByEmployee(employeeId: string): Promise<OnboardingProgress | null> {
    for (const p of this.progressStore.values()) {
      if (p.employeeId === employeeId) return p;
    }
    return null;
  }

  async save(p: OnboardingProgress): Promise<void> {
    this.progressStore.set(p.id, p);
  }

  async update(p: OnboardingProgress): Promise<number> {
    // Rend 0 quand la ligne n'existe pas — c'est ce que fait un UPDATE SQL, et c'est la
    // divergence qui a laissé passer le bug : l'ancien double écrivait inconditionnellement
    // l'objet entier, donc il conservait des horodatages que Drizzle, lui, jetait.
    if (!this.progressStore.has(p.id)) return 0;
    this.progressStore.set(p.id, p);
    return 1;
  }

  async findSteps(progressId: string): Promise<OnboardingStep[]> {
    return Array.from(this.stepStore.values()).filter((s) => s.progressId === progressId);
  }

  async saveStep(s: OnboardingStep): Promise<void> {
    this.stepStore.set(s.id, s);
  }

  async updateStep(s: OnboardingStep): Promise<void> {
    this.stepStore.set(s.id, s);
  }
}

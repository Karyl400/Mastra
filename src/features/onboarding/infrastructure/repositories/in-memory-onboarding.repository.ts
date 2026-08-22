import type { OnboardingProgress } from '../../domain/entities/onboarding-progress';
import type { OnboardingRepository } from '../../domain/ports/onboarding.repository';

export class InMemoryOnboardingRepository implements OnboardingRepository {
  private progressStore = new Map<string, OnboardingProgress>();

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
    if (!this.progressStore.has(p.id)) return 0;
    this.progressStore.set(p.id, p);
    return 1;
  }
}

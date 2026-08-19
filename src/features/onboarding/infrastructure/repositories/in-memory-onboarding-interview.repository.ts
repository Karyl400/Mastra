import type {
  OnboardingInterview,
  OnboardingInterviewRepository,
} from '../../domain/ports/onboarding-interview.repository';

/**
 * Doublure de `DrizzleOnboardingInterviewRepository`.
 *
 * ⚠️ Elle doit reproduire la propriété que le SQL obtient en ne nommant pas `created_at` dans
 * son `set` : une correction ne réécrit PAS la date du premier entretien. Une doublure plus
 * permissive validerait en test un comportement que la production n'a pas — et l'écart porterait
 * précisément sur une perte silencieuse de donnée.
 */
export class InMemoryOnboardingInterviewRepository implements OnboardingInterviewRepository {
  private rows = new Map<string, OnboardingInterview>();

  async findByEmployee(employeeId: string): Promise<OnboardingInterview | null> {
    return this.rows.get(employeeId) ?? null;
  }

  async listAll(): Promise<OnboardingInterview[]> {
    return [...this.rows.values()];
  }

  async save(interview: OnboardingInterview): Promise<void> {
    const existing = this.rows.get(interview.employeeId);
    this.rows.set(interview.employeeId, {
      ...interview,
      createdAt: existing?.createdAt ?? interview.createdAt,
    });
  }
}

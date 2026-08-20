import type {
  OnboardingInterview,
  OnboardingInterviewRepository,
} from '../../domain/ports/onboarding-interview.repository';

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

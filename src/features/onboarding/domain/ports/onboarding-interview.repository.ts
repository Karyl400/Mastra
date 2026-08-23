export interface OnboardingInterview {
  readonly employeeId: string;
  readonly slackUserId: string;
  readonly channels: readonly string[];
  readonly dailyWork: string;
  readonly workStyle: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OnboardingInterviewRepository {
  findByEmployee(employeeId: string): Promise<OnboardingInterview | null>;

  findAll(): Promise<OnboardingInterview[]>;

  save(interview: OnboardingInterview): Promise<void>;
}

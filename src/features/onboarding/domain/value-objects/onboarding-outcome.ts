import { errorMessage } from '../../../../shared/errors';

export enum OnboardingOutcome {
  Completed = 'completed',
  Degraded = 'degraded',
  Failed = 'failed',
}

export enum BestEffortStep {
  WelcomeEmail = 'welcomeEmail',
  SlackInvite = 'slackInvite',
}

export interface StepFailure {
  readonly step: BestEffortStep;
  readonly reason: string;
}

export function toFailureReason(error: unknown): string {
  const raw = errorMessage(error);
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : 'cause inconnue';
}

export function outcomeOf(failures: readonly StepFailure[]): OnboardingOutcome {
  return failures.length > 0 ? OnboardingOutcome.Degraded : OnboardingOutcome.Completed;
}

export function describeDegradation(failures: readonly StepFailure[]): string {
  if (failures.length === 0) return 'aucune';
  return failures.map((failure) => `${failure.step} (${failure.reason})`).join(' ; ');
}

import { createHash } from 'node:crypto';

import { logger } from '../../../../shared/logger';
import {
  PROFILE_EMAIL_TAKEN_REPLY,
  PROFILE_SUBMISSION_FAILED_REPLY,
  describeMissingSteps,
  profileSubmissionDegradedReply,
} from '../../domain/services/onboarding-replies';
import {
  OnboardingOutcome,
  describeDegradation,
  type StepFailure,
} from '../../domain/value-objects/onboarding-outcome';

export interface OnboardingProfile {
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly position: string;
}

interface WorkflowRunResult {
  status: string;
  result?: {
    employeeId?: string;
    outcome?: OnboardingOutcome;
    emailSent?: boolean;
    slackInvited?: boolean;
    degradedSteps?: StepFailure[];
  };
  error?: unknown;
}

interface WorkflowLike {
  createRun(options?: { runId?: string }): Promise<{
    start(args: { inputData: unknown }): Promise<WorkflowRunResult>;
  }>;
}

export interface RunOnboardingDeps {
  readonly getWorkflow: (key: string) => unknown;
  readonly notify: (text: string) => Promise<void>;
  readonly onRecordReady: (employeeId: string | undefined) => Promise<void>;
}

function isEmailAlreadyTaken(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 8; depth += 1) {
    const node = current as { code?: unknown; statusCode?: unknown; cause?: unknown };
    if (node.code === 'CONFLICT' || node.statusCode === 409) return true;
    current = node.cause;
  }
  return false;
}

export function onboardingRunId(email: string): string {
  const digest = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  return `onboarding-${digest.slice(0, 32)}`;
}

export async function runOnboarding(
  deps: RunOnboardingDeps,
  profile: OnboardingProfile,
  startDate: string,
): Promise<void> {
  const workflow = deps.getWorkflow('employeeOnboardingWorkflow') as WorkflowLike | undefined;

  if (!workflow) {
    logger.error('Workflow employeeOnboardingWorkflow introuvable dans le registre Mastra');
    await deps.notify(PROFILE_SUBMISSION_FAILED_REPLY);
    return;
  }

  const run = await workflow.createRun({ runId: onboardingRunId(profile.email) });

  const result = await run.start({
    inputData: {
      firstName: profile.firstName,
      lastName: profile.lastName,
      email: profile.email,
      department: null,
      position: profile.position,
      startDate,
      slackChannelId: null,
    },
  });

  if (result.status !== 'success') {
    const emailTaken = isEmailAlreadyTaken(result.error);

    logger.error('Onboarding workflow failed', {
      email: profile.email,
      outcome: OnboardingOutcome.Failed,
      emailTaken,
      error: result.error,
    });

    await deps.notify(emailTaken ? PROFILE_EMAIL_TAKEN_REPLY : PROFILE_SUBMISSION_FAILED_REPLY);
    return;
  }

  const degradedSteps = result.result?.degradedSteps ?? [];

  if (result.result?.outcome === OnboardingOutcome.Degraded) {
    logger.error('Onboarding workflow completed in DEGRADED mode', {
      email: profile.email,
      outcome: result.result.outcome,
      degradedSteps: describeDegradation(degradedSteps),
      emailSent: result.result?.emailSent,
      slackInvited: result.result?.slackInvited,
    });

    const missing = describeMissingSteps(degradedSteps);
    if (missing.length > 0) {
      await deps.notify(profileSubmissionDegradedReply(missing));
    }
  } else {
    logger.info('Onboarding workflow completed', {
      email: profile.email,
      outcome: result.result?.outcome,
      emailSent: result.result?.emailSent,
      slackInvited: result.result?.slackInvited,
    });
  }

  await deps.onRecordReady(result.result?.employeeId);
}

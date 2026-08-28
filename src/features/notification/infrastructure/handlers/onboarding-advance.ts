import type { SlackHandlerInternals } from './handler-internals';
import { maybeCheckProfileDone } from './profile-done-check';
import { maybeRunProfileStep } from './profile-journey';
import { maybeRunInterviewStep, type InterviewStepInput } from './interview-journey';

export async function maybeAdvanceOnboarding(
  self: SlackHandlerInternals,
  input: InterviewStepInput,
): Promise<boolean> {
  if (await maybeCheckProfileDone(self, input)) return true;
  if (await maybeRunProfileStep(self, input)) return true;
  return await maybeRunInterviewStep(self, input);
}

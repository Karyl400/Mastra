import { pickVariant } from '../../../../shared/reply-variants';
import type { ProfileStep } from './profile-chat';
import type { InterviewStep } from './interview-chat';

const PROFILE_LABELS: Readonly<Record<ProfileStep, string>> = {
  firstName: 'ton prénom',
  lastName: 'ton nom de famille',
  email: 'ton adresse email',
  position: 'l’intitulé de ton poste',
};

const INTERVIEW_LABELS: Readonly<Record<InterviewStep, string>> = {
  dailyWork: 'ce que tu fais au quotidien',
  workStyle: 'ta façon de travailler',
};

const VARIANTS: readonly string[] = [
  '_(Au fait, il me manque encore %s pour boucler ton dossier.)_',
  '_(Quand tu veux : il me reste %s à noter pour ton dossier.)_',
  '_(Je garde ton dossier de côté — il n’y manque que %s.)_',
];

export interface PendingOnboardingStep {
  readonly kind: 'profile' | 'interview';
  readonly step: ProfileStep | InterviewStep;
}

export function onboardingNudge(
  pending: PendingOnboardingStep | undefined,
  messageTs?: string,
): string | undefined {
  if (!pending) return undefined;

  const label =
    pending.kind === 'profile'
      ? PROFILE_LABELS[pending.step as ProfileStep]
      : INTERVIEW_LABELS[pending.step as InterviewStep];

  if (!label) return undefined;

  return pickVariant(VARIANTS, messageTs).replace('%s', label);
}

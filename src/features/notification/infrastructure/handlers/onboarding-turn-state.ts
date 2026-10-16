import type { ConversationTurn } from '../../../conversation/domain/entities/conversation-turn';
import { findActingReply } from '../../domain/services/deterministic-replies';
import {
  INTERVIEW_QUESTION_STYLE,
  INTERVIEW_SKIPPED_REPLY,
  captureInterviewAnswer,
  interviewRetryReply,
  isQuestionToBot,
  pendingInterviewStep,
  type InterviewStep,
} from '../../../onboarding/domain/services/interview-chat';
import { pendingProfileStep } from '../../../onboarding/domain/services/profile-chat';
import type { PendingOnboardingStep } from '../../../onboarding/domain/services/onboarding-nudge';

export function pendingOnboardingStep(
  history: readonly ConversationTurn[],
  isDirectMessage: boolean,
): PendingOnboardingStep | undefined {
  if (!isDirectMessage) return undefined;

  const last = lastAssistantText(history);

  const profile = pendingProfileStep(last);
  if (profile) return { kind: 'profile', step: profile };

  const interview = pendingInterviewStep(last);
  if (interview) return { kind: 'interview', step: interview };

  return undefined;
}

export function answersOnboardingQuestion(input: {
  readonly history: readonly ConversationTurn[];
  readonly isDirectMessage: boolean;
  readonly text: string;
}): boolean {
  if (!input.isDirectMessage) return false;
  if (!hasPendingOnboardingQuestion(input.history)) return false;
  if (findActingReply({ text: input.text, isDirectMessage: true })) return false;
  return !isQuestionToBot(input.text);
}

export function shouldRememberTurn(history: readonly ConversationTurn[]): boolean {
  return !hasPendingOnboardingQuestion(history);
}

export function hasPendingOnboardingQuestion(history: readonly ConversationTurn[]): boolean {
  const last = lastAssistantText(history);
  return pendingProfileStep(last) !== null || pendingInterviewStep(last) !== null;
}

export function lastAssistantText(history: readonly ConversationTurn[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i]!;
    if (turn.role === 'assistant') return turn.content;
  }
  return undefined;
}

export function interviewReplyFor(step: InterviewStep, text: string, skipped: boolean): string {
  if (skipped) return INTERVIEW_SKIPPED_REPLY;

  const answer = captureInterviewAnswer(text);
  if (!answer) return interviewRetryReply(step);
  if (step === 'dailyWork') return INTERVIEW_QUESTION_STYLE;
  return interviewDoneReply(answer);
}

export function interviewDoneReply(workStyle: string): string {
  const echo = workStyle.length > 60 ? `${workStyle.slice(0, 60)}…` : workStyle;
  return (
    `Compris — ${echo}. C’est tout ce dont j’avais besoin. Demande-moi ton guide d’accueil ` +
    'quand tu veux, j’y mettrai ce que tu viens de me dire.'
  );
}

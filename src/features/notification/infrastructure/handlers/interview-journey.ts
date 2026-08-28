import { logger } from '../../../../shared/logger';
import type { ConversationTurn } from '../../../conversation/domain/entities/conversation-turn';
import { DEFAULT_AGENT_ID } from '../../domain/services/agent-routing';
import {
  captureInterviewAnswer,
  pendingInterviewStep,
  skipsInterview,
  type InterviewStep,
} from '../../../onboarding/domain/services/interview-chat';
import type { SlackHandlerInternals } from './handler-internals';
import { rememberTurn } from './conversation-memory';
import {
  answersOnboardingQuestion,
  interviewReplyFor,
  lastAssistantText,
} from './onboarding-turn-state';

export interface InterviewStepInput {
  history: readonly ConversationTurn[];
  isDirectMessage: boolean;
  text: string;
  channel: string;
  threadTs: string | undefined;
  conversationId: string;
  user: string | undefined;
  employeeId: string | null | undefined;
}

export async function maybeRunInterviewStep(
  self: SlackHandlerInternals,
  input: InterviewStepInput,
): Promise<boolean> {
  if (!answersOnboardingQuestion(input)) return false;

  const step = pendingInterviewStep(lastAssistantText(input.history));
  if (!step) return false;

  await runInterviewStep(self, { ...input, step });
  return true;
}

async function runInterviewStep(
  self: SlackHandlerInternals,
  input: InterviewStepInput & { step: InterviewStep },
): Promise<void> {
  const { step, text, channel, threadTs, conversationId, user } = input;

  const skipped = skipsInterview(text);
  const reply = interviewReplyFor(step, text, skipped);

  logger.info(`Entretien conversationnel (${step}) — aucun appel de modele`, {
    channel,
    skipped,
  });

  await self.slack.chat.postMessage({
    channel,
    text: reply,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });

  await rememberTurn(self, {
    conversationId,
    role: 'user',
    content: text,
    agentId: DEFAULT_AGENT_ID,
    slackUserId: user ?? null,
  });
  await rememberTurn(self, {
    conversationId,
    role: 'assistant',
    content: reply,
    agentId: DEFAULT_AGENT_ID,
    slackUserId: null,
  });

  await persistInterviewAnswer(self, input, skipped);
}

async function persistInterviewAnswer(
  self: SlackHandlerInternals,
  input: {
    step: InterviewStep;
    text: string;
    employeeId: string | null | undefined;
    user: string | undefined;
  },
  skipped: boolean,
): Promise<void> {
  const answer = skipped ? null : captureInterviewAnswer(input.text);
  if (!answer || !self.interviewRepo || !input.user) return;

  if (!input.employeeId) {
    logger.error('Réponse d’entretien PERDUE — annuaire non relié au dossier', {
      reason: 'missing_employee_id',
      slackUserId: input.user,
      step: input.step,
    });
    return;
  }

  try {
    const existing = await self.interviewRepo.findByEmployee(input.employeeId);
    const now = new Date();
    await self.interviewRepo.save({
      employeeId: input.employeeId,
      slackUserId: input.user,
      channels: existing?.channels ?? [],
      dailyWork: input.step === 'dailyWork' ? answer : (existing?.dailyWork ?? ''),
      workStyle: input.step === 'workStyle' ? answer : (existing?.workStyle ?? ''),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  } catch (error) {
    logger.error('Réponse d’entretien non persistée — la conversation, elle, a abouti', {
      error: String(error),
      step: input.step,
    });
  }
}

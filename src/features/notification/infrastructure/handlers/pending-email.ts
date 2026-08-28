import { logger } from '../../../../shared/logger';
import type { ConversationTurn } from '../../../conversation/domain/entities/conversation-turn';
import type { PendingInterviewEmail } from '../../../recruitment/domain/ports/pending-email.repository';
import {
  ALREADY_SETTLED_REPLY,
  CANCELLED_REPLY,
  confirmPendingEmail,
  pendingEmailVerdict,
  pendingReminder,
  staleReply,
} from '../../../recruitment/application/services/confirm-pending-email';
import type { SlackHandlerInternals } from './handler-internals';
import { sayAndRemember } from './conversation-memory';
import { hasPendingOnboardingQuestion } from './onboarding-turn-state';

export function cancellationReply(cleared: number): string {
  if (cleared > 0) return CANCELLED_REPLY;
  if (cleared === 0) return ALREADY_SETTLED_REPLY;
  return 'Je n’ai pas réussi à annuler cet email — rien n’est parti pour autant. Redis-moi « non » dans un instant.';
}

export async function resolvePendingEmail(
  self: SlackHandlerInternals,
  input: {
    text: string;
    channel: string;
    threadTs: string | undefined;
    user: string | undefined;
    conversationId: string;
    history: readonly ConversationTurn[];
  },
): Promise<{ handled: boolean; reminder?: string }> {
  const repo = self.pendingEmailRepo;
  const send = self.sendEmail;
  if (!repo || !send) return { handled: false };

  let pending: PendingInterviewEmail | null;
  try {
    pending = await repo.find(input.conversationId);
  } catch (error) {
    logger.error('Email d’entretien en attente illisible', { error: String(error) });
    return { handled: false };
  }
  if (!pending) return { handled: false };

  const verdict = pendingEmailVerdict({
    pending,
    text: input.text,
    onboardingQuestionPending: hasPendingOnboardingQuestion(input.history),
    now: self.now(),
  });

  if (verdict === 'stale') {
    await repo.clear(pending.conversationId).catch((error) => {
      logger.error('Préparation périmée non effacée', { error: String(error) });
      return 0;
    });
    logger.info('Email d’entretien abandonné — préparation périmée');
    return { handled: false, reminder: staleReply(pending) };
  }

  if (verdict === 'deferred') {
    return { handled: false, reminder: pendingReminder(pending) };
  }

  if (verdict === 'cancel') {
    const cleared = await repo.clear(pending.conversationId).catch((error) => {
      logger.error('Annulation d’email d’entretien échouée', { error: String(error) });
      return -1;
    });
    const reply = cancellationReply(cleared);
    await sayAndRemember(
      self,
      {
        channel: input.channel,
        threadTs: input.threadTs,
        conversationId: input.conversationId,
        user: input.user,
        text: input.text,
      },
      reply,
    );
    return { handled: true };
  }

  if (verdict === 'send') {
    const outcome = await confirmPendingEmail(
      { pending: repo, sendEmail: send },
      pending,
      input.user,
    );
    await sayAndRemember(
      self,
      {
        channel: input.channel,
        threadTs: input.threadTs,
        conversationId: input.conversationId,
        user: input.user,
        text: input.text,
      },
      outcome.reply,
    );
    return { handled: true };
  }

  return { handled: false, reminder: pendingReminder(pending) };
}

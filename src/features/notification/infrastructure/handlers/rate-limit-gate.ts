import { logger } from '../../../../shared/logger';
import { AUDIT_ACTIONS } from '../../../../shared/audit-actions';
import { isAnsweredWithoutModel } from '../../domain/services/deterministic-replies';
import { deriveConversationId } from '../../../conversation/domain/value-objects/conversation-id';
import {
  pendingEmailVerdict,
  settlesPendingEmail,
} from '../../../recruitment/application/services/confirm-pending-email';
import type { SlackHandlerInternals } from './handler-internals';
import {
  isTeamJoinEvent,
  resolveThreadTarget,
  type SlackEvent,
  type SlackEventDecision,
} from './slack-event.types';
import { cleanText } from './message-text';
import { loadHistory, pruneIsDue } from './conversation-memory';
import { answersOnboardingQuestion, hasPendingOnboardingQuestion } from './onboarding-turn-state';

export const RATE_LIMIT_REPLIES: Readonly<Record<string, string>> = {
  workspaceTokens:
    "Le budget d'IA partagé de l'équipe est épuisé pour aujourd'hui. Il repart demain — " +
    'ce n’est pas ton quota à toi, et personne ne peut le relever en attendant.',
  daily:
    "Tu as atteint ta part du budget partagé pour aujourd'hui. Elle repart demain, et " +
    'elle est relevable — c’est un réglage de déploiement.',
  burst: 'Tu m’écris plus vite que je ne sais répondre. Laisse-moi une minute et reformule.',
};

export function eventIsAnsweredWithoutModel(event: SlackEvent): boolean {
  if (isTeamJoinEvent(event)) {
    return false;
  }

  return isAnsweredWithoutModel({
    text: cleanText(event.text),
    subtype: event.subtype,
    isDirectMessage: event.channel_type === 'im' || (event.channel ?? '').startsWith('D'),
  });
}

export async function checkRateLimit(
  self: SlackHandlerInternals,
  event: SlackEvent,
): Promise<SlackEventDecision | null> {
  const limiter = self.getRateLimiter();
  if (!limiter) {
    return null;
  }

  const subject = isTeamJoinEvent(event) ? event.user?.id : event.user;
  if (!subject) {
    return null;
  }

  try {
    const decision = await limiter.check(subject, new Date(), {
      answeredWithoutModel: eventIsAnsweredWithoutModel(event),
      reserveOnly: true,
    });
    if (decision.allowed) {
      return null;
    }

    if (decision.rationsModelBudget && (await settlesWithoutModel(self, event))) {
      logger.info('Rate limit waived: this message is answered without a model', {
        slackUserId: subject,
        rule: decision.rule,
      });
      return null;
    }

    logger.warn('Slack event dropped: rate limit exceeded', {
      slackUserId: subject,
      rule: decision.rule,
      degraded: decision.degraded,
    });

    void self.audit({
      action: AUDIT_ACTIONS.rateLimited,
      actorId: subject,
      status: 'denied',
      details: { rule: decision.rule, degraded: decision.degraded },
    });

    if (decision.shouldNotify && !isTeamJoinEvent(event) && event.channel) {
      await notifyRateLimited(self, event.channel, decision.rule);
    }

    return { action: 'ignore', reason: 'rate_limited' };
  } catch (error) {
    logger.error('Rate limit check failed — letting the event through', { error });
    return null;
  }
}

export async function chargeModelBudget(
  self: SlackHandlerInternals,
  slackUserId: string | undefined,
): Promise<boolean> {
  if (!slackUserId) {
    return true;
  }
  const limiter = self.getRateLimiter();
  if (!limiter) {
    return true;
  }

  try {
    const claim = await limiter.claimModelBudget(slackUserId);
    if (!claim.allowed) {
      logger.warn('Model budget exhausted at claim time — message not served', { slackUserId });
    }
    return claim.allowed;
  } catch (error) {
    logger.error('Could not charge the model budget — serving the message anyway', { error });
    return true;
  }
}

async function settlesWithoutModel(
  self: SlackHandlerInternals,
  event: SlackEvent,
): Promise<boolean> {
  if (isTeamJoinEvent(event) || !event.channel) {
    return false;
  }

  const { isDirectMessage, threadTs } = resolveThreadTarget(event, event.channel);
  const conversationId = deriveConversationId({ channel: event.channel, threadTs });
  const text = cleanText(event.text);

  try {
    const [history, pending] = await Promise.all([
      loadHistory(self, conversationId),
      self.pendingEmailRepo && self.sendEmail
        ? self.pendingEmailRepo.find(conversationId)
        : Promise.resolve(null),
    ]);

    if (answersOnboardingQuestion({ history, isDirectMessage, text })) {
      return true;
    }

    if (!pending) {
      return false;
    }

    return settlesPendingEmail(
      pendingEmailVerdict({
        pending,
        text,
        onboardingQuestionPending: hasPendingOnboardingQuestion(history),
        now: self.now(),
      }),
    );
  } catch (error) {
    logger.warn('Could not tell whether this message is answered without a model', {
      error: String(error),
    });
    return false;
  }
}

export async function notifyRateLimited(
  self: SlackHandlerInternals,
  channel: string,
  rule: string | null,
): Promise<void> {
  try {
    await self.slack.chat.postMessage({
      channel,
      text: (rule && RATE_LIMIT_REPLIES[rule]) || RATE_LIMIT_REPLIES.burst,
    });
  } catch (error) {
    logger.warn('Could not notify the user about the rate limit', { channel, error });
  }
}

export function scheduleRateLimitPruneIfDue(self: SlackHandlerInternals): void {
  if (!pruneIsDue(self)) {
    return;
  }

  void self.getRateLimiter()?.pruneExpired();
}

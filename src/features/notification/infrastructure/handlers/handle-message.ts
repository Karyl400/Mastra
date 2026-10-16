import { logger } from '../../../../shared/logger';
import { AUDIT_ACTIONS } from '../../../../shared/audit-actions';
import { findActingReply } from '../../domain/services/deterministic-replies';
import { onboardingNudge } from '../../../onboarding/domain/services/onboarding-nudge';
import { startProgress } from '../providers/slack-progress';
import type { SlackHandlerInternals } from './handler-internals';
import type { SlackMessageEvent } from './slack-event.types';
import { buildMessageContext, runStaticReply } from './message-context';
import { resolvePendingEmail } from './pending-email';
import { pendingOnboardingStep, shouldRememberTurn } from './onboarding-turn-state';
import { runErasure, runPinFact } from './acting-shortcuts';
import { runCancelReminder } from './reminder-cancellation';
import { runProfileForm } from './profile-form';
import { enforceAuthorization } from './requester-identity';
import { chargeModelBudget, notifyRateLimited } from './rate-limit-gate';
import { runIntentChain } from './intent-chain-runner';
import { runDeadline } from '../../../../shared/llm/run-deadline';

export async function handleMessage(
  self: SlackHandlerInternals,
  event: SlackMessageEvent,
): Promise<void> {
  const deadline = runDeadline(Date.now());
  const context = await buildMessageContext(self, event);
  if (!context) return;

  const {
    user,
    channel,
    text,
    threadTs,
    isDirectMessage,
    conversationId,
    requesterIdentity,
    history,
  } = context;

  const shortCircuitInput = {
    text,
    subtype: event.subtype,
    isDirectMessage,
    messageTs: event.ts,
  };
  if (
    await runStaticReply(self, {
      input: shortCircuitInput,
      history,
      channel,
      threadTs,
      conversationId,
      user,
    })
  ) {
    return;
  }

  const pendingEmail = await resolvePendingEmail(self, {
    text,
    channel,
    threadTs,
    user,
    conversationId,
    history,
  });
  if (pendingEmail.handled) return;

  const pendingStep = pendingOnboardingStep(history, isDirectMessage);

  if (
    await self.maybeAdvanceOnboarding({
      history,
      isDirectMessage,
      text,
      channel,
      threadTs,
      conversationId,
      user,
      employeeId: (await requesterIdentity).employeeId,
    })
  ) {
    return;
  }

  const acting = findActingReply(shortCircuitInput);

  if (acting) {
    switch (acting.action) {
      case 'erasure':
        return runErasure(self, {
          text,
          channel,
          threadTs,
          user,
          conversationId,
          isDirectMessage,
        });
      case 'pin_fact':
        return runPinFact(self, { text, channel, threadTs, user });
      case 'profile_form':
        return runProfileForm(self, {
          channel,
          threadTs,
          isDirectMessage,
          conversationId,
          user,
        });
      case 'cancel_reminder':
        return runCancelReminder(self, {
          text,
          channel,
          threadTs,
          conversationId,
          user,
          employeeId: (await requesterIdentity).employeeId,
          remember: shouldRememberTurn(history),
        });
    }
  }

  const accessLevel = await enforceAuthorization(self, {
    user,
    channel,
    threadTs,
    isDirectMessage,
  });
  if (accessLevel === 'denied') return;

  if (isDirectMessage && user) {
    void self
      .getDirectoryRepo()
      ?.rememberDmChannel(user, channel)
      .catch((error) => logger.debug('Could not record the DM channel', { user, error }));
  }

  logger.info('Processing Slack message', { user, channel, textLength: text.length });

  void self.audit({
    action: AUDIT_ACTIONS.slackMessage,
    actorId: user ?? 'unknown',
    status: 'accepted',
    resourceType: 'SlackChannel',
    resourceId: channel,
    details: { accessLevel: accessLevel ?? 'not_evaluated', isDirectMessage },
  });

  if (!(await chargeModelBudget(self, user))) {
    await notifyRateLimited(self, channel, 'daily');
    return;
  }

  const progress = await startProgress(self.slack, { channel, threadTs });

  await runIntentChain(self, {
    event,
    text,
    channel,
    threadTs,
    user,
    conversationId,
    isDirectMessage,
    history,
    requesterIdentity,
    accessLevel,
    progress,
    deadline,
    pendingEmailReminder: pendingEmail.reminder,
    onboardingReminder: onboardingNudge(pendingStep, event.ts),
  });
}

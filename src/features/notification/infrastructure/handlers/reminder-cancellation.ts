import { logger } from '../../../../shared/logger';
import {
  NO_REMINDER_TO_CANCEL_REPLY,
  REMINDER_ALREADY_SENT_REPLY,
  REMINDER_CANCEL_FAILED_REPLY,
  REMINDER_CANCEL_NO_RECORD_REPLY,
  pickReminderToCancel,
  reminderCancelChoiceReply,
  reminderCancelledReply,
  remindersCancelledReply,
  remindersPartlyUnreachable,
  requestsReminderCancellation,
} from '../../../../shared/cancel-reminder';
import { DISPATCH_LOOKUP_STATUSES, deliveryLabel } from '../../domain/services/reminder-dispatch';
import type { SlackHandlerInternals } from './handler-internals';
import { sayAndRemember } from './conversation-memory';
import type { NotificationRepository } from '../../domain/ports/notification.repository';

export async function runCancelReminder(
  self: SlackHandlerInternals,
  ctx: {
    text: string;
    channel: string;
    threadTs?: string;
    conversationId: string;
    user?: string;
    employeeId?: string | null;
    remember: boolean;
  },
): Promise<void> {
  const { text, channel, threadTs, conversationId, user, employeeId, remember } = ctx;
  const say = (reply: string) =>
    sayAndRemember(self, { channel, threadTs, conversationId, user, text, remember }, reply);

  const scope = requestsReminderCancellation(text);
  if (!scope) return;

  const repo = self.notificationRepo;
  if (!repo) {
    logger.error('Cancel reminder requested but no notification repository is wired');
    return say(REMINDER_CANCEL_FAILED_REPLY);
  }

  if (!employeeId) {
    logger.info('Cancel reminder requested by someone with no employee record', { channel });
    return say(REMINDER_CANCEL_NO_RECORD_REPLY);
  }

  let pending;
  try {
    const all = await repo.findByRecipient(employeeId);
    pending = all.filter((one) => DISPATCH_LOOKUP_STATUSES.includes(one.status));
  } catch (error) {
    logger.error('Cancel reminder — pending reminders could not be read', { error, channel });
    return say(REMINDER_CANCEL_FAILED_REPLY);
  }

  if (pending.length === 0) {
    logger.info('Cancel reminder requested with nothing pending — no LLM call', { channel });
    return say(NO_REMINDER_TO_CANCEL_REPLY);
  }

  const now = self.now();
  const candidates = pending.map((one) => ({
    id: one.id,
    subject: one.subject,
    deliveredOn: one.scheduledAt ? deliveryLabel(one.scheduledAt, now) : null,
  }));

  try {
    if (scope === 'all')
      return say(await cancelEveryPending(repo, candidates, employeeId, channel));

    const pick = pickReminderToCancel(candidates, text);
    if ('ambiguous' in pick) {
      logger.info('Cancel reminder — several candidates, none designated', {
        channel,
        candidates: pick.ambiguous.length,
      });
      return say(reminderCancelChoiceReply(pick.ambiguous));
    }

    const cancelled = await repo.cancelIfPending(pick.chosen.id, employeeId);
    logger.info('Reminder cancellation attempted — answered without any LLM call', {
      channel,
      id: pick.chosen.id,
      cancelled,
    });
    return say(
      cancelled
        ? reminderCancelledReply(pick.chosen.subject, pick.chosen.deliveredOn)
        : REMINDER_ALREADY_SENT_REPLY,
    );
  } catch (error) {
    logger.error('Cancel reminder failed', { error, channel });
    return say(REMINDER_CANCEL_FAILED_REPLY);
  }
}

async function cancelEveryPending(
  repo: NotificationRepository,
  candidates: ReadonlyArray<{ id: string; subject: string; deliveredOn: string | null }>,
  employeeId: string,
  channel: string,
): Promise<string> {
  const taken = await Promise.allSettled(
    candidates.map((one) => repo.cancelIfPending(one.id, employeeId)),
  );
  const count = taken.filter((one) => one.status === 'fulfilled' && one.value).length;
  const broken = taken.filter((one) => one.status === 'rejected');

  for (const failure of broken) {
    logger.error('Cancel reminder failed for one of several', {
      channel,
      error: (failure as PromiseRejectedResult).reason,
    });
  }

  logger.info('Reminders cancelled — answered without any LLM call', {
    channel,
    asked: candidates.length,
    cancelled: count,
    errored: broken.length,
  });

  if (count === 0) {
    return broken.length > 0 ? REMINDER_CANCEL_FAILED_REPLY : REMINDER_ALREADY_SENT_REPLY;
  }

  const reply = remindersCancelledReply(count, candidates.length - broken.length);
  return broken.length > 0 ? reply + remindersPartlyUnreachable(broken.length) : reply;
}

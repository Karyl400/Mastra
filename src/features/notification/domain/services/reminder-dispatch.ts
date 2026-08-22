import { frenchDayLabel } from '../../../../shared/french-datetime';
import { DISPLAY_TIMEZONE } from '../../../../shared/french-datetime';
import { NotificationStatus } from '../../../../shared/types';
import type { Notification } from '../entities/notification';

export const REMINDER_DISPATCH_PATH = '/internal/reminders/dispatch';
export const REMINDER_DISPATCH_SCHEDULE = '0 6 * * *';
export const REMINDER_DISPATCH_HOUR_UTC = 6;

export const MAX_REMINDERS_PER_RUN = 25;

export const STALE_AFTER_DAYS = 7;

const DAY_MS = 86_400_000;

export const DISPATCHABLE_STATUSES: readonly NotificationStatus[] = [
  NotificationStatus.Scheduled,
  NotificationStatus.Pending,
];

export const DISPATCH_LOOKUP_STATUSES: readonly NotificationStatus[] = [
  ...DISPATCHABLE_STATUSES,
  NotificationStatus.Sending,
];

const DISPATCHABLE: ReadonlySet<string> = new Set(DISPATCHABLE_STATUSES);

export function isDispatchableStatus(status: string): boolean {
  return DISPATCHABLE.has(status);
}

export const STRANDED_CLAIM_MS = 6 * 60 * 60 * 1000;

export function isStrandedClaim(
  notification: Pick<Notification, 'status' | 'updatedAt'>,
  now: Date,
): boolean {
  if (notification.status !== NotificationStatus.Sending) return false;
  const at = Date.parse(notification.updatedAt ?? '');
  if (Number.isNaN(at)) return false;
  return now.getTime() - at >= STRANDED_CLAIM_MS;
}

function localDayKey(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

export function isDueForDispatch(
  notification: Pick<Notification, 'status' | 'scheduledAt' | 'updatedAt'>,
  now: Date,
  timeZone: string = DISPLAY_TIMEZONE,
): boolean {
  if (!DISPATCHABLE.has(notification.status) && !isStrandedClaim(notification, now)) return false;
  if (!notification.scheduledAt) return false;

  const at = Date.parse(notification.scheduledAt);
  if (Number.isNaN(at)) return false;

  if (now.getTime() - at > STALE_AFTER_DAYS * DAY_MS) return false;

  return localDayKey(new Date(at), timeZone) <= localDayKey(now, timeZone);
}

export function isStaleReminder(
  notification: Pick<Notification, 'status' | 'scheduledAt'>,
  now: Date,
): boolean {
  if (
    !DISPATCHABLE.has(notification.status) &&
    notification.status !== NotificationStatus.Sending
  ) {
    return false;
  }
  const at = notification.scheduledAt ? Date.parse(notification.scheduledAt) : Number.NaN;
  if (Number.isNaN(at)) return false;
  return now.getTime() - at > STALE_AFTER_DAYS * DAY_MS;
}

export function selectStaleReminders(all: readonly Notification[], now: Date): Notification[] {
  return all.filter((n) => isStaleReminder(n, now));
}

export function selectDueReminders(
  all: readonly Notification[],
  now: Date,
  limit: number = MAX_REMINDERS_PER_RUN,
  timeZone: string = DISPLAY_TIMEZONE,
): Notification[] {
  return all
    .filter((n) => isDueForDispatch(n, now, timeZone))
    .sort((a, b) => (a.scheduledAt ?? '').localeCompare(b.scheduledAt ?? ''))
    .slice(0, limit);
}

export function nextDeliveryAt(scheduledAt: string, now: Date): Date | null {
  const at = Date.parse(scheduledAt);
  if (Number.isNaN(at)) return null;

  const run = new Date(at);
  run.setUTCHours(REMINDER_DISPATCH_HOUR_UTC, 0, 0, 0);

  while (run.getTime() < now.getTime()) run.setTime(run.getTime() + DAY_MS);

  return run;
}

export function deliveryLabel(
  scheduledAt: string,
  now: Date,
  timeZone: string = DISPLAY_TIMEZONE,
): string | null {
  const at = nextDeliveryAt(scheduledAt, now);
  return at ? `${frenchDayLabel(at, timeZone)} au matin` : null;
}

export function reminderPreamble(
  scheduledAt: string | null | undefined,
  timeZone: string = DISPLAY_TIMEZONE,
): string {
  const at = scheduledAt ? Date.parse(scheduledAt) : Number.NaN;
  if (Number.isNaN(at)) {
    return 'Tu m’avais demandé de te remettre ceci en tête.';
  }
  return `Tu m’avais demandé de te remettre ceci en tête pour ${frenchDayLabel(new Date(at), timeZone)}.`;
}

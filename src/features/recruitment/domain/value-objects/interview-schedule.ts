import {
  DISPLAY_TIMEZONE,
  frenchFullLabel,
  frenchShortLabel,
} from '../../../../shared/french-datetime';

export const INTERVIEW_TIMEZONE = DISPLAY_TIMEZONE;

export const MAX_INTERVIEW_HORIZON_MS = 365 * 24 * 60 * 60 * 1000;

export type InterviewScheduleError = 'invalid_date' | 'date_in_past' | 'date_too_far';

export interface InterviewSchedule {
  readonly at: Date;
  readonly humanReadable: string;
  readonly shortLabel: string;
}

export function parseInterviewSchedule(
  isoDateTime: string,
  now: Date,
): { ok: true; schedule: InterviewSchedule } | { ok: false; reason: InterviewScheduleError } {
  const at = new Date(isoDateTime);

  if (Number.isNaN(at.getTime())) return { ok: false, reason: 'invalid_date' };

  if (at.getTime() <= now.getTime()) return { ok: false, reason: 'date_in_past' };

  if (at.getTime() - now.getTime() > MAX_INTERVIEW_HORIZON_MS) {
    return { ok: false, reason: 'date_too_far' };
  }

  return {
    ok: true,
    schedule: {
      at,
      humanReadable: frenchFullLabel(at, INTERVIEW_TIMEZONE),
      shortLabel: frenchShortLabel(at, INTERVIEW_TIMEZONE),
    },
  };
}

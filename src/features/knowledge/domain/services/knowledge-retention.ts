export const MIN_RETENTION_DAYS = 7;

export interface RetentionWindow {
  readonly enabled: boolean;
  readonly days: number | null;
  readonly before: number | null;
  readonly reason?: 'not_configured' | 'not_a_number' | 'below_minimum';
}

export function resolveRetentionWindow(
  raw: string | undefined,
  now: Date = new Date(),
): RetentionWindow {
  const trimmed = raw?.trim();
  if (!trimmed) return { enabled: false, days: null, before: null, reason: 'not_configured' };

  const days = Number(trimmed);
  if (!Number.isFinite(days) || days <= 0) {
    return { enabled: false, days: null, before: null, reason: 'not_a_number' };
  }

  if (days < MIN_RETENTION_DAYS) {
    return { enabled: false, days, before: null, reason: 'below_minimum' };
  }

  return { enabled: true, days, before: now.getTime() - days * 86_400_000 };
}

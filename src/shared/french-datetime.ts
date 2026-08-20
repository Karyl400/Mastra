export const DISPLAY_TIMEZONE =
  process.env.DISPLAY_TIMEZONE || process.env.RECRUITMENT_TIMEZONE || 'Africa/Lagos';

export function frenchDate(
  at: Date,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): string {
  try {
    return new Intl.DateTimeFormat('fr-FR', { ...options, timeZone }).format(at);
  } catch {
    return at.toISOString();
  }
}

export function frenchShortLabel(at: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
      timeZone,
    }).formatToParts(at);
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    return `${get('weekday')} ${get('day')} ${get('month')} à ${get('hour')}:${get('minute')}`;
  } catch {
    return at.toISOString();
  }
}

export function frenchOffsetLabel(at: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('fr-FR', {
      timeZone,
      timeZoneName: 'longOffset',
    }).formatToParts(at);
    return parts.find((part) => part.type === 'timeZoneName')?.value ?? 'UTC';
  } catch {
    return 'UTC';
  }
}

export function frenchDayLabel(at: Date, timeZone: string = DISPLAY_TIMEZONE): string {
  return frenchDate(at, timeZone, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

export function frenchFullLabel(at: Date, timeZone: string): string {
  return `${frenchDate(at, timeZone, { dateStyle: 'full', timeStyle: 'short' })} (${frenchOffsetLabel(at, timeZone)})`;
}

export function formatFrenchDay(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;

  try {
    return new Intl.DateTimeFormat('fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

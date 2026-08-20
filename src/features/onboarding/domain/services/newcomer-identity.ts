export interface NewcomerIdentity {
  slackUserId: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  joinedAt?: string | null;
}

export function normalizeStartDate(date: string): string {
  return `${date}T00:00:00.000Z`;
}

export function startDateFromJoin(joinedAt: string | null | undefined, now: Date): string {
  const parsed = joinedAt ? new Date(joinedAt) : null;
  const valid = parsed && !Number.isNaN(parsed.getTime()) ? parsed : now;
  return normalizeStartDate(valid.toISOString().slice(0, 10));
}

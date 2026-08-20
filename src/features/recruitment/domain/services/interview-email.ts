import type { InterviewSchedule } from '../value-objects/interview-schedule';

export const INTERVIEW_LINK_DOMAINS: readonly string[] = [
  'meet.google.com',
  'zoom.us',
  'teams.microsoft.com',
  'teams.live.com',
  'whereby.com',
  'kissohq.slack.com',
];

export const COMPANY_NAME = 'Kisso Industries';

export interface InterviewEmailInput {
  readonly candidateName?: string;
  readonly schedule: InterviewSchedule;
  readonly position?: string;
  readonly location?: string;
  readonly replyTo?: string;
}

export interface InterviewEmail {
  readonly subject: string;
  readonly body: string;
}

export function buildInterviewEmail(input: InterviewEmailInput): InterviewEmail {
  const subject = `Entretien ${COMPANY_NAME} — ${input.schedule.shortLabel}`;

  const name = input.candidateName?.trim();
  const lines: string[] = [name ? `Bonjour ${name},` : 'Bonjour,', ''];

  lines.push(
    input.position?.trim()
      ? `Nous avons le plaisir de vous convier à un entretien pour le poste de ${input.position.trim()}.`
      : `Nous avons le plaisir de vous convier à un entretien.`,
  );
  lines.push('');

  lines.push(`Date : ${input.schedule.humanReadable}`);
  if (input.location?.trim()) lines.push(`Lieu : ${input.location.trim()}`);

  if (input.replyTo?.trim()) {
    lines.push('');
    lines.push(`Merci de nous confirmer votre présence en écrivant à ${input.replyTo.trim()}.`);
  }

  lines.push('', 'À bientôt,', `L'équipe ${COMPANY_NAME}`);

  return { subject, body: lines.join('\n') };
}

export type LocationVerdict =
  { ok: true } | { ok: false; reason: 'link_domain_not_allowed'; host: string };

export function checkInterviewLocation(location: string | undefined): LocationVerdict {
  const value = location?.trim();
  if (!value) return { ok: true };

  const url = extractUrl(value);
  if (!url) return { ok: true };

  const host = url.hostname.toLowerCase();
  const allowed = INTERVIEW_LINK_DOMAINS.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
  return allowed ? { ok: true } : { ok: false, reason: 'link_domain_not_allowed', host };
}

function extractUrl(value: string): URL | null {
  const match = /(https?:\/\/[^\s<>"']+)/i.exec(value);
  if (!match) return null;
  try {
    return new URL(match[1]!);
  } catch {
    return null;
  }
}

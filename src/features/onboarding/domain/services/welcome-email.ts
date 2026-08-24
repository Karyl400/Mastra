export interface WelcomeEmailInput {
  readonly firstName: string;
  readonly lastName: string;
  readonly position?: string | null;
  readonly startDate?: string | null;
  readonly channels?: readonly string[];
}

export interface WelcomeEmail {
  readonly subject: string;
  readonly body: string;
}

import { formatFrenchDay } from '../../../../shared/french-date';
import { ASSISTANT_NAME } from '../../../../shared/assistant-identity';

const COMPANY = 'Kisso Industries';

function isFutureDay(startDate: string | null | undefined): boolean {
  if (!startDate) return false;
  const parsed = new Date(startDate);
  if (Number.isNaN(parsed.getTime())) return false;

  const startOfDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return startOfDay(parsed) > startOfDay(new Date());
}

export function buildWelcomeEmail(input: WelcomeEmailInput): WelcomeEmail {
  const firstName = input.firstName.trim();

  const known: string[] = [];
  if (input.position?.trim()) known.push(`comme <strong>${esc(input.position.trim())}</strong>`);

  const day = formatFrenchDay(input.startDate);

  const parts: string[] = [`<p>Bonjour ${esc(firstName)},</p>`];

  const welcome =
    known.length > 0
      ? `Ravis de t'accueillir chez ${COMPANY} ${known.join(' ')}.`
      : `Ravis de t'accueillir chez ${COMPANY}.`;
  parts.push(`<p>${welcome}</p>`);

  if (day && isFutureDay(input.startDate)) {
    parts.push(`<p>On t'attend le <strong>${esc(day)}</strong>.</p>`);
  }

  const channels = (input.channels ?? []).map((c) => c.trim()).filter(Boolean);
  if (channels.length > 0) {
    const rendered = channels.map((c) => `<strong>#${esc(c)}</strong>`).join(', ');
    parts.push(`<p>Tu as déjà ta place dans ${rendered}.</p>`);
  }

  if (known.length > 0 || day || channels.length > 0) {
    parts.push(
      `<p>Si quelque chose est inexact, dis-le nous — c'est plus simple à corriger maintenant.</p>`,
    );
  }

  parts.push(
    `<p>Tu vas recevoir un message direct de ${ASSISTANT_NAME} sur Slack : il t'expliquera comment compléter ton dossier, en quelques messages. C'est par là que tout commence.</p>`,
    `<p>À très vite,<br/><strong>L'équipe ${COMPANY}</strong></p>`,
  );

  return {
    subject: `Bienvenue chez ${COMPANY}, ${firstName}`,
    body: parts.join(''),
  };
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

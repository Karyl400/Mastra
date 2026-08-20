import type { InterviewConfirmationPresenter } from '../../domain/ports/interview-confirmation.presenter';

export const SEND_INTERVIEW_ACTION_ID = 'send_interview_email';
export const CANCEL_INTERVIEW_ACTION_ID = 'cancel_interview_email';

export interface InterviewConfirmPayload {
  readonly to: string;
  readonly candidateName?: string;
  readonly startsAt: string;
  readonly position?: string;
  readonly location?: string;
  readonly replyTo?: string;
  readonly requesterUserId: string;
}

const MAX_VALUE_CHARS = 2000;

export function encodeInterviewConfirm(payload: InterviewConfirmPayload): string {
  const encoded = JSON.stringify(payload);
  if (encoded.length > MAX_VALUE_CHARS) {
    throw new Error(
      `Charge de confirmation trop longue (${encoded.length} > ${MAX_VALUE_CHARS}) : ` +
        'Slack refuserait le bloc. Raccourcis le lieu ou le poste.',
    );
  }
  return encoded;
}

export function decodeInterviewConfirm(raw: string | undefined): InterviewConfirmPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<InterviewConfirmPayload>;
    if (
      typeof parsed?.to !== 'string' ||
      typeof parsed?.startsAt !== 'string' ||
      typeof parsed?.requesterUserId !== 'string'
    ) {
      return null;
    }
    return parsed as InterviewConfirmPayload;
  } catch {
    return null;
  }
}

interface Block {
  type: string;
  [key: string]: unknown;
}

export function buildInterviewConfirmBlocks(input: {
  payload: InterviewConfirmPayload;
  humanReadableDate: string;
  subject: string;
  body: string;
}): Block[] {
  const facts = [`*À* ${input.payload.to}`, `*Quand* ${input.humanReadableDate}`];
  if (input.payload.position) facts.push(`*Poste* ${input.payload.position}`);
  if (input.payload.location) facts.push(`*Lieu* ${input.payload.location}`);

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Entretien à envoyer* — relis avant d'envoyer, l'envoi est définitif.\n\n${facts.join('\n')}`,
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `\`\`\`${input.subject}\n\n${input.body}\`\`\`` },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: SEND_INTERVIEW_ACTION_ID,
          style: 'primary',
          text: { type: 'plain_text', text: 'Envoyer' },
          value: encodeInterviewConfirm(input.payload),
          confirm: {
            title: { type: 'plain_text', text: 'Envoyer cet email ?' },
            text: { type: 'mrkdwn', text: `Il partira à *${input.payload.to}*. C'est définitif.` },
            confirm: { type: 'plain_text', text: 'Envoyer' },
            deny: { type: 'plain_text', text: 'Annuler' },
          },
        },
        {
          type: 'button',
          action_id: CANCEL_INTERVIEW_ACTION_ID,
          text: { type: 'plain_text', text: 'Annuler' },
          value: 'cancel',
        },
      ],
    },
  ];
}

export function buildSettledCardBlocks(input: {
  verdict: string;
  facts?: readonly string[];
}): Block[] {
  const facts = input.facts && input.facts.length > 0 ? `\n\n${input.facts.join('\n')}` : '';
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `${input.verdict}${facts}` },
    },
  ];
}

export function confirmFacts(payload: InterviewConfirmPayload, whenLabel: string): string[] {
  return [`*À* ${payload.to}`, `*Quand* ${whenLabel}`];
}

export function interviewConfirmFallback(candidateName?: string): string {
  return candidateName ? `Entretien à confirmer pour ${candidateName}` : 'Entretien à confirmer';
}

export const INTERVIEW_SENT_REPLY = (to: string, whenLabel: string): string =>
  `C'est envoyé à ${to}, pour ${whenLabel}.`;

export const INTERVIEW_CANCELLED_REPLY = "Annulé — aucun email n'est parti.";

export const INTERVIEW_NOT_YOURS_REPLY =
  "Cette invitation n'est pas la tienne : seule la personne qui l'a préparée peut l'envoyer.";

export const INTERVIEW_SEND_FAILED_REPLY =
  "Je n'ai pas pu envoyer l'email — rien n'est parti. Réessaie, ou préviens l'équipe technique.";

export const slackInterviewConfirmationPresenter: InterviewConfirmationPresenter = {
  buildConfirmationText: (input) => buildInterviewConfirmText(input),
  fallbackText: (candidateName) => interviewConfirmFallback(candidateName),
};

export function buildInterviewConfirmText(input: {
  payload: { to: string; candidateName?: string };
  humanReadableDate: string;
  subject: string;
  body: string;
}): string {
  const nom = input.payload.candidateName?.trim();
  const destinataire = nom ? `${nom} (${input.payload.to})` : input.payload.to;

  return [
    `Voici l’email que je peux envoyer à *${destinataire}*, pour le *${input.humanReadableDate}*.`,
    '',
    `*Objet* — ${input.subject}`,
    '',
    input.body,
    '',
    `Veux-tu que je l’envoie à ${input.payload.to} ? *Cet envoi est définitif.* Réponds « oui » ou « non ».`,
  ].join('\n');
}

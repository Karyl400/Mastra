import type { EmailAttachment } from '../ports/providers';

export const MAX_EMAIL_ATTACHMENTS_BYTES = 5 * 1024 * 1024;

function formatMib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mio`;
}

export function totalAttachmentBytes(attachments: readonly EmailAttachment[]): number {
  return attachments.reduce((total, attachment) => total + attachment.bytes.byteLength, 0);
}

export function assertEmailAttachmentsFit(attachments: readonly EmailAttachment[]): void {
  const total = totalAttachmentBytes(attachments);
  if (total <= MAX_EMAIL_ATTACHMENTS_BYTES) return;

  const names = attachments.map((attachment) => attachment.filename).join(', ');
  throw new Error(
    `Pièces jointes trop volumineuses : ${formatMib(total)} au total pour ${attachments.length} ` +
      `fichier(s) (${names}), la limite est ${formatMib(MAX_EMAIL_ATTACHMENTS_BYTES)}. ` +
      "L'envoi part d'une fonction serverless dont la connexion SMTP expire à 10 s : " +
      'au-delà de cette borne le socket lâche en cours de transfert. Réduire ou scinder le document.',
  );
}

import type { EmailAttachment, EmailProvider } from '../../domain/ports/providers';
import type { EmailBody } from '../../domain/services/email-body';
import { assertEmailAttachmentsFit } from '../../domain/services/email-attachment-policy';

export class BrevoAdapter implements EmailProvider {
  private apiKey: string;
  private from: string;
  private fromName?: string;

  constructor(apiKey: string, from: string, fromName?: string) {
    this.apiKey = apiKey;
    this.from = from;
    this.fromName = fromName;
  }

  async sendEmail(
    to: string,
    subject: string,
    body: EmailBody,
    attachments?: EmailAttachment[],
  ): Promise<void> {
    if (attachments?.length) assertEmailAttachmentsFit(attachments);

    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': this.apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { email: this.from, ...(this.fromName ? { name: this.fromName } : {}) },
        to: [{ email: to }],
        subject,
        htmlContent: body.html,
        textContent: body.text,
        ...(attachments?.length
          ? {
              attachment: attachments.map((attachment) => ({
                content: Buffer.from(attachment.bytes).toString('base64'),
                name: attachment.filename,
              })),
            }
          : {}),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to send email via Brevo: ${response.status} ${errorText}`);
    }
  }
}

import { Resend } from 'resend';
import type { EmailProvider } from '../../domain/ports/providers';

export class ResendAdapter implements EmailProvider {
  private resend: Resend;
  private from: string;

  constructor(apiKey: string, from: string) {
    this.resend = new Resend(apiKey);
    this.from = from;
  }

  async sendEmail(to: string, subject: string, body: string): Promise<void> {
    await this.resend.emails.send({
      from: this.from,
      to,
      subject,
      html: body,
    });
  }
}

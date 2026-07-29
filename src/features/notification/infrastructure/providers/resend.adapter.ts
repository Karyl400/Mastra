import { Resend } from 'resend';
import type { EmailProvider } from '../../domain/ports/providers';
import { config } from '../../../../config/index';

export class ResendAdapter implements EmailProvider {
  private resend: Resend;

  constructor() {
    this.resend = new Resend(config.notifications.resend.apiKey);
  }

  async sendEmail(to: string, subject: string, body: string): Promise<void> {
    await this.resend.emails.send({
      from: config.notifications.from,
      to,
      subject,
      html: body,
    });
  }
}

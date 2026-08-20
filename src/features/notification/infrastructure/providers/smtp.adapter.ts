import nodemailer, { type Transporter } from 'nodemailer';
import type { EmailAttachment, EmailProvider } from '../../domain/ports/providers';
import type { EmailBody } from '../../domain/services/email-body';
import { assertEmailAttachmentsFit } from '../../domain/services/email-attachment-policy';

export interface SmtpAdapterConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from?: string;
  fromName?: string;
  secure?: boolean;
  transporter?: Transporter;
}

const SMTP_TIMEOUT_MS = 10_000;

export class SmtpAdapter implements EmailProvider {
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(config: SmtpAdapterConfig) {
    const { host, port, user, pass, from, fromName, secure, transporter } = config;

    if (!host) throw new Error('SmtpAdapter: SMTP_HOST is required');
    if (!user) throw new Error('SmtpAdapter: SMTP_USER is required');
    if (!pass) throw new Error('SmtpAdapter: SMTP_PASS is required');

    const address = from || user;
    this.from = fromName ? `"${fromName}" <${address}>` : address;

    this.transporter =
      transporter ??
      nodemailer.createTransport({
        host,
        port,
        secure: secure ?? port === 465,
        requireTLS: true,
        auth: { user, pass },
        connectionTimeout: SMTP_TIMEOUT_MS,
        greetingTimeout: SMTP_TIMEOUT_MS,
        socketTimeout: SMTP_TIMEOUT_MS,
      });
  }

  async verify(): Promise<void> {
    await this.transporter.verify();
  }

  async sendEmail(
    to: string,
    subject: string,
    body: EmailBody,
    attachments?: EmailAttachment[],
  ): Promise<void> {
    if (attachments?.length) assertEmailAttachmentsFit(attachments);

    try {
      await this.transporter.sendMail({
        from: this.from,
        to,
        subject,
        html: body.html,
        text: body.text,
        ...(attachments?.length
          ? {
              attachments: attachments.map((attachment) => ({
                filename: attachment.filename,
                content: Buffer.from(attachment.bytes),
                contentType: attachment.mimeType,
              })),
            }
          : {}),
      });
    } catch (error) {
      const err = error as { responseCode?: number; code?: string; message?: string };

      if (err.responseCode === 534 || /application-specific password/i.test(err.message ?? '')) {
        throw new Error(
          "SMTP auth refusée : Gmail exige un mot de passe d'application (16 caractères), " +
            'pas le mot de passe du compte. Activez la validation en deux étapes puis générez-en ' +
            'un dans Compte Google → Sécurité → Mots de passe des applications.',
          { cause: error },
        );
      }

      throw new Error(
        `Failed to send email via SMTP: ${err.code ?? err.responseCode ?? 'unknown'} ${err.message ?? ''}`.trim(),
        { cause: error },
      );
    }
  }
}

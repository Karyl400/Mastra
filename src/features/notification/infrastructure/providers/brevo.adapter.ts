import type { EmailAttachment, EmailProvider } from '../../domain/ports/providers';
import { assertEmailAttachmentsFit } from '../../domain/services/email-attachment-policy';

/**
 * Adaptateur email Brevo — chemin de REPLI, mort en pratique.
 *
 * `createEmailProvider()` ne le retient que si la configuration SMTP est
 * incomplète. Et même alors il n'enverra rien : la clé est valide
 * (`GET /v3/account` → 200) mais `POST /v3/smtp/email` répond
 * `403 permission_denied` — le compte transactionnel n'est pas activé, ce qui se
 * règle chez Brevo et non dans la configuration.
 *
 * Il est malgré tout maintenu cohérent avec le port `EmailProvider` : sans cela
 * TypeScript casserait au premier ajout au port, et une éventuelle reprise du
 * chemin Brevo enverrait un corps de requête silencieusement invalide.
 */
export class BrevoAdapter implements EmailProvider {
  private apiKey: string;
  private from: string;

  constructor(apiKey: string, from: string) {
    this.apiKey = apiKey;
    this.from = from;
  }

  async sendEmail(
    to: string,
    subject: string,
    body: string,
    attachments?: EmailAttachment[],
  ): Promise<void> {
    // Même borne que SMTP, et pour la même raison : ici le binaire est en plus
    // encodé en base64 DANS le corps JSON, soit +33 % sur le fil et deux copies
    // simultanées en mémoire de la fonction.
    if (attachments?.length) assertEmailAttachmentsFit(attachments);

    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': this.apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { email: this.from },
        to: [{ email: to }],
        subject,
        htmlContent: body,
        // L'API Brevo attend `attachment` (singulier), avec `content` en base64 et
        // `name` — ce n'est ni le nom ni la forme de la clé nodemailer. Absente
        // quand il n'y a rien à joindre, pour ne pas modifier les envois existants.
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

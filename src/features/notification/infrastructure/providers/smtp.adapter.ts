import nodemailer, { type Transporter } from 'nodemailer';
import type { EmailAttachment, EmailProvider } from '../../domain/ports/providers';
import { assertEmailAttachmentsFit } from '../../domain/services/email-attachment-policy';

/**
 * Adaptateur email SMTP (Gmail et tout serveur SMTP classique).
 *
 * Pourquoi cet adaptateur existe : Brevo refuse d'envoyer tant que le compte
 * transactionnel n'est pas activé (`403 permission_denied`), et la validation d'un
 * expéditeur sur un domaine que l'on ne possède pas est impossible. SMTP permet
 * d'envoyer immédiatement, sans domaine à vérifier.
 *
 * ⚠️ GMAIL — MOT DE PASSE D'APPLICATION OBLIGATOIRE
 * Depuis mai 2022, Google refuse le mot de passe habituel du compte pour SMTP :
 *   `534-5.7.9 Application-specific password required`
 * Il faut un « App Password » de 16 caractères, ce qui suppose la validation en deux
 * étapes activée sur le compte :
 *   Compte Google → Sécurité → Validation en deux étapes → Mots de passe des applications
 * `SMTP_PASS` doit contenir ce mot de passe d'application, jamais celui du compte.
 *
 * ⚠️ SERVERLESS (Vercel)
 * SMTP maintient une connexion TCP, contrairement à une API HTTP. Sur une fonction
 * serverless c'est plus lent et plus fragile qu'un appel `fetch` : la connexion ne
 * survit pas au gel de la fonction. On désactive donc le pool et on borne les timeouts
 * pour échouer vite plutôt que de bloquer l'appelant.
 */

export interface SmtpAdapterConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  /** Expéditeur affiché. À défaut, `user`. */
  from?: string;
  /** Nom affiché à côté de l'adresse. */
  fromName?: string;
  /** TLS implicite (port 465). Déduit du port si absent. */
  secure?: boolean;
  /** Injection d'un transport (tests unitaires). */
  transporter?: Transporter;
}

/** Timeouts serrés : mieux vaut échouer vite que retenir la requête HTTP appelante. */
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
    // `from` doit rester une adresse simple ; le nom est ajouté au format RFC 5322.
    this.from = fromName ? `"${fromName}" <${address}>` : address;

    this.transporter =
      transporter ??
      nodemailer.createTransport({
        host,
        port,
        // Port 465 = TLS implicite ; 587 = STARTTLS (secure:false puis upgrade).
        secure: secure ?? port === 465,
        auth: { user, pass },
        // Pas de `pool: false` ici : c'est déjà le défaut de nodemailer, et le typage
        // `SMTPTransport.Options` ne connaît pas la clé `pool` (elle n'existe que sur
        // `SMTPPool.Options`, où elle vaut obligatoirement `true`). L'ajouter fait
        // dérailler la résolution de surcharge de `createTransport` (TS2769).
        connectionTimeout: SMTP_TIMEOUT_MS,
        greetingTimeout: SMTP_TIMEOUT_MS,
        socketTimeout: SMTP_TIMEOUT_MS,
      });
  }

  /**
   * Vérifie la connexion et l'authentification sans envoyer de message.
   * Utile au diagnostic (`scripts/smoke-email.mjs`) — ne PAS appeler à chaud sur
   * chaque envoi, cela double le coût d'une connexion SMTP.
   */
  async verify(): Promise<void> {
    await this.transporter.verify();
  }

  async sendEmail(
    to: string,
    subject: string,
    body: string,
    attachments?: EmailAttachment[],
  ): Promise<void> {
    // Vérifié AVANT d'ouvrir la connexion : sur une fonction serverless, laisser
    // partir un envoi trop lourd coûte les 10 s du timeout socket pour finir sur
    // un `ETIMEDOUT` qui ne dit rien de la vraie cause.
    if (attachments?.length) assertEmailAttachmentsFit(attachments);

    try {
      await this.transporter.sendMail({
        from: this.from,
        to,
        subject,
        html: body,
        // Repli texte brut : certains clients refusent un message uniquement HTML,
        // et cela améliore le score anti-spam.
        text: body
          // `[^>]+` ne peut pas reculer devant `>`, qu'il exclut : 0,02 ms mesurées sur
          // 8 000 caractères adverses.
          // eslint-disable-next-line sonarjs/super-linear-regex
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim(),
        // La clé n'est posée que s'il y a réellement quelque chose à joindre :
        // les appelants historiques doivent produire un message strictement
        // identique à l'existant. `content` doit être un Buffer — nodemailer ne
        // contractualise pas l'`Uint8Array`.
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

      // Message explicite pour l'erreur Gmail la plus fréquente, sinon on perd 20 min
      // à croire que le mot de passe est faux alors qu'il est simplement du mauvais type.
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

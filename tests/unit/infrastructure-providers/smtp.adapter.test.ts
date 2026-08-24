import {
  htmlEmailBody,
  textEmailBody,
} from '../../../src/features/notification/domain/services/email-body';
import { describe, it, expect, vi, afterEach } from 'vitest';
import nodemailer, { type Transporter } from 'nodemailer';
import { SmtpAdapter } from '../../../src/features/notification/infrastructure/providers/smtp.adapter';
import { MAX_EMAIL_ATTACHMENTS_BYTES } from '../../../src/features/notification/domain/services/email-attachment-policy';

/** Transport nodemailer factice : on n'ouvre jamais de vraie connexion SMTP en test. */
function makeTransporter(sendMail: unknown = vi.fn().mockResolvedValue({ messageId: 'x' })) {
  return { sendMail, verify: vi.fn().mockResolvedValue(true) } as unknown as Transporter;
}

const baseConfig = {
  host: 'smtp.gmail.com',
  port: 587,
  user: 'bot@gmail.com',
  pass: 'abcd efgh ijkl mnop',
};

describe('SmtpAdapter', () => {
  describe('transport TLS', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /**
     * On n'injecte PAS de transporter ici : c'est justement `createTransport`
     * qu'on veut observer. Le spy rend une doublure, aucune connexion n'est ouverte.
     */
    function captureTransportOptions(config: Partial<typeof baseConfig> & { secure?: boolean }) {
      const createTransport = vi
        .spyOn(nodemailer, 'createTransport')
        .mockReturnValue(makeTransporter() as never);

      new SmtpAdapter({ ...baseConfig, ...config });

      return createTransport.mock.calls[0][0] as Record<string, unknown>;
    }

    it('exige STARTTLS sur le port 587 — sinon auth et corps partent en clair', () => {
      // STARTTLS opportuniste : sans `requireTLS`, un serveur qui n'annonce pas
      // l'extension fait envoyer identifiants et message en clair, sans erreur.
      const options = captureTransportOptions({ port: 587 });

      expect(options.requireTLS).toBe(true);
      expect(options.secure).toBe(false);
    });

    it('garde `requireTLS` sur le port 465, où TLS est implicite', () => {
      // nodemailer ne consulte `requireTLS` pour la bascule STARTTLS que si
      // `secure` est faux (smtp-connection/index.js : `!this.secure && ...`),
      // donc l'option est inoffensive ici — et elle protège une éventuelle
      // erreur de configuration du port.
      const options = captureTransportOptions({ port: 465 });

      expect(options.secure).toBe(true);
      expect(options.requireTLS).toBe(true);
    });

    it('respecte un `secure` explicite sans lâcher `requireTLS`', () => {
      const options = captureTransportOptions({ port: 2525, secure: true });

      expect(options.secure).toBe(true);
      expect(options.requireTLS).toBe(true);
    });

    it('transmet hôte, port, identifiants et délais', () => {
      const options = captureTransportOptions({ port: 587 });

      expect(options).toMatchObject({
        host: 'smtp.gmail.com',
        port: 587,
        auth: { user: 'bot@gmail.com', pass: 'abcd efgh ijkl mnop' },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 10_000,
      });
    });

    it("n'appelle pas `createTransport` quand un transporter est injecté", () => {
      const createTransport = vi
        .spyOn(nodemailer, 'createTransport')
        .mockReturnValue(makeTransporter() as never);

      new SmtpAdapter({ ...baseConfig, transporter: makeTransporter() });

      expect(createTransport).not.toHaveBeenCalled();
    });
  });

  describe('configuration', () => {
    it('exige host, user et pass', () => {
      expect(() => new SmtpAdapter({ ...baseConfig, host: '' })).toThrow(/SMTP_HOST/);
      expect(() => new SmtpAdapter({ ...baseConfig, user: '' })).toThrow(/SMTP_USER/);
      expect(() => new SmtpAdapter({ ...baseConfig, pass: '' })).toThrow(/SMTP_PASS/);
    });

    it('utilise `user` comme expéditeur quand `from` est absent', async () => {
      const sendMail = vi.fn().mockResolvedValue({});
      const adapter = new SmtpAdapter({ ...baseConfig, transporter: makeTransporter(sendMail) });

      await adapter.sendEmail('dest@example.com', 'Sujet', htmlEmailBody('<p>Corps</p>'));

      expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: 'bot@gmail.com' }));
    });

    it('formate `from` au format RFC 5322 quand un nom est fourni', async () => {
      const sendMail = vi.fn().mockResolvedValue({});
      const adapter = new SmtpAdapter({
        ...baseConfig,
        from: 'noreply@kisso.com',
        fromName: 'Marcel',
        transporter: makeTransporter(sendMail),
      });

      await adapter.sendEmail('dest@example.com', 'Sujet', htmlEmailBody('<p>Corps</p>'));

      expect(sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ from: '"Marcel" <noreply@kisso.com>' }),
      );
    });
  });

  describe('sendEmail', () => {
    it('transmet destinataire, sujet et corps HTML', async () => {
      const sendMail = vi.fn().mockResolvedValue({});
      const adapter = new SmtpAdapter({ ...baseConfig, transporter: makeTransporter(sendMail) });

      await adapter.sendEmail('dest@example.com', 'Bienvenue', htmlEmailBody('<p>Bonjour</p>'));

      expect(sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'dest@example.com',
          subject: 'Bienvenue',
          html: '<p>Bonjour</p>',
        }),
      );
    });

    it('ajoute un repli texte brut dérivé du HTML', async () => {
      const sendMail = vi.fn().mockResolvedValue({});
      const adapter = new SmtpAdapter({ ...baseConfig, transporter: makeTransporter(sendMail) });

      await adapter.sendEmail(
        'dest@example.com',
        'Sujet',
        htmlEmailBody('<h1>Titre</h1>\n<p>Ligne</p>'),
      );

      expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ text: 'Titre Ligne' }));
    });
  });

  describe('pièces jointes', () => {
    it('traduit une pièce jointe du port en `attachments` nodemailer', async () => {
      const sendMail = vi.fn().mockResolvedValue({});
      const adapter = new SmtpAdapter({ ...baseConfig, transporter: makeTransporter(sendMail) });

      await adapter.sendEmail('dest@example.com', 'Guide', htmlEmailBody('<p>Ci-joint</p>'), [
        { filename: 'guide.pdf', bytes: new Uint8Array([1, 2, 3]), mimeType: 'application/pdf' },
      ]);

      const mail = sendMail.mock.calls[0][0];
      expect(mail.attachments).toHaveLength(1);
      expect(mail.attachments[0].filename).toBe('guide.pdf');
      expect(mail.attachments[0].contentType).toBe('application/pdf');
      // Nodemailer accepte un Buffer ; un `Uint8Array` nu n'est pas dans son contrat.
      expect(Buffer.isBuffer(mail.attachments[0].content)).toBe(true);
      expect(Buffer.from(mail.attachments[0].content).equals(Buffer.from([1, 2, 3]))).toBe(true);
    });

    it("n'ajoute AUCUNE clé `attachments` quand aucune pièce jointe n'est fournie", async () => {
      // Non-régression : les appelants existants (send-notification, workflow
      // d'onboarding) n'ont pas été modifiés, leur message doit rester identique.
      const sendMail = vi.fn().mockResolvedValue({});
      const adapter = new SmtpAdapter({ ...baseConfig, transporter: makeTransporter(sendMail) });

      await adapter.sendEmail('dest@example.com', 'Sujet', htmlEmailBody('<p>Corps</p>'));
      await adapter.sendEmail('dest@example.com', 'Sujet', htmlEmailBody('<p>Corps</p>'), []);

      expect(sendMail.mock.calls[0][0]).not.toHaveProperty('attachments');
      expect(sendMail.mock.calls[1][0]).not.toHaveProperty('attachments');
    });

    it('refuse un total au-delà de la borne, sans ouvrir de connexion SMTP', async () => {
      // Une pièce jointe volumineuse traverse une connexion TCP dans une fonction
      // serverless dont les timeouts sont à 10 s : mieux vaut un message clair
      // qu'un socket qui expire.
      const sendMail = vi.fn().mockResolvedValue({});
      const adapter = new SmtpAdapter({ ...baseConfig, transporter: makeTransporter(sendMail) });

      const half = new Uint8Array(Math.ceil(MAX_EMAIL_ATTACHMENTS_BYTES * 0.6));

      await expect(
        adapter.sendEmail('dest@example.com', 'Guide', htmlEmailBody('<p>x</p>'), [
          { filename: 'a.pdf', bytes: half, mimeType: 'application/pdf' },
          { filename: 'b.pdf', bytes: half, mimeType: 'application/pdf' },
        ]),
      ).rejects.toThrow(/pièces jointes/i);

      expect(sendMail).not.toHaveBeenCalled();
    });

    it('accepte un total exactement égal à la borne', async () => {
      const sendMail = vi.fn().mockResolvedValue({});
      const adapter = new SmtpAdapter({ ...baseConfig, transporter: makeTransporter(sendMail) });

      await adapter.sendEmail('dest@example.com', 'Guide', htmlEmailBody('<p>x</p>'), [
        {
          filename: 'guide.pdf',
          bytes: new Uint8Array(MAX_EMAIL_ATTACHMENTS_BYTES),
          mimeType: 'application/pdf',
        },
      ]);

      expect(sendMail).toHaveBeenCalledTimes(1);
    });
  });

  describe('gestion des erreurs', () => {
    it("traduit le 534 Gmail en consigne de mot de passe d'application", async () => {
      const sendMail = vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('Application-specific password required'), { responseCode: 534 }),
        );
      const adapter = new SmtpAdapter({ ...baseConfig, transporter: makeTransporter(sendMail) });

      await expect(adapter.sendEmail('dest@example.com', 'S', textEmailBody('B'))).rejects.toThrow(
        /mot de passe d'application/i,
      );
    });

    it('propage les autres erreurs SMTP sans les masquer', async () => {
      const sendMail = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }));
      const adapter = new SmtpAdapter({ ...baseConfig, transporter: makeTransporter(sendMail) });

      await expect(adapter.sendEmail('dest@example.com', 'S', textEmailBody('B'))).rejects.toThrow(
        /Failed to send email via SMTP: ETIMEDOUT/,
      );
    });

    it('ne laisse jamais passer une erreur silencieusement', async () => {
      const sendMail = vi.fn().mockRejectedValue(new Error('boom'));
      const adapter = new SmtpAdapter({ ...baseConfig, transporter: makeTransporter(sendMail) });

      await expect(
        adapter.sendEmail('dest@example.com', 'S', textEmailBody('B')),
      ).rejects.toThrow();
    });
  });
});

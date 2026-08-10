import { describe, it, expect, vi } from 'vitest';
import type { Transporter } from 'nodemailer';
import { SmtpAdapter } from '../../../src/features/notification/infrastructure/providers/smtp.adapter';

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
  describe('configuration', () => {
    it('exige host, user et pass', () => {
      expect(() => new SmtpAdapter({ ...baseConfig, host: '' })).toThrow(/SMTP_HOST/);
      expect(() => new SmtpAdapter({ ...baseConfig, user: '' })).toThrow(/SMTP_USER/);
      expect(() => new SmtpAdapter({ ...baseConfig, pass: '' })).toThrow(/SMTP_PASS/);
    });

    it('utilise `user` comme expéditeur quand `from` est absent', async () => {
      const sendMail = vi.fn().mockResolvedValue({});
      const adapter = new SmtpAdapter({ ...baseConfig, transporter: makeTransporter(sendMail) });

      await adapter.sendEmail('dest@example.com', 'Sujet', '<p>Corps</p>');

      expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: 'bot@gmail.com' }));
    });

    it('formate `from` au format RFC 5322 quand un nom est fourni', async () => {
      const sendMail = vi.fn().mockResolvedValue({});
      const adapter = new SmtpAdapter({
        ...baseConfig,
        from: 'noreply@kisso.com',
        fromName: 'Kisso Onboarding',
        transporter: makeTransporter(sendMail),
      });

      await adapter.sendEmail('dest@example.com', 'Sujet', '<p>Corps</p>');

      expect(sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ from: '"Kisso Onboarding" <noreply@kisso.com>' })
      );
    });
  });

  describe('sendEmail', () => {
    it('transmet destinataire, sujet et corps HTML', async () => {
      const sendMail = vi.fn().mockResolvedValue({});
      const adapter = new SmtpAdapter({ ...baseConfig, transporter: makeTransporter(sendMail) });

      await adapter.sendEmail('dest@example.com', 'Bienvenue', '<p>Bonjour</p>');

      expect(sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'dest@example.com',
          subject: 'Bienvenue',
          html: '<p>Bonjour</p>',
        })
      );
    });

    it('ajoute un repli texte brut dérivé du HTML', async () => {
      const sendMail = vi.fn().mockResolvedValue({});
      const adapter = new SmtpAdapter({ ...baseConfig, transporter: makeTransporter(sendMail) });

      await adapter.sendEmail('dest@example.com', 'Sujet', '<h1>Titre</h1>\n<p>Ligne</p>');

      expect(sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Titre Ligne' })
      );
    });
  });

  describe('gestion des erreurs', () => {
    it("traduit le 534 Gmail en consigne de mot de passe d'application", async () => {
      const sendMail = vi.fn().mockRejectedValue(
        Object.assign(new Error('Application-specific password required'), { responseCode: 534 })
      );
      const adapter = new SmtpAdapter({ ...baseConfig, transporter: makeTransporter(sendMail) });

      await expect(adapter.sendEmail('dest@example.com', 'S', 'B')).rejects.toThrow(
        /mot de passe d'application/i
      );
    });

    it('propage les autres erreurs SMTP sans les masquer', async () => {
      const sendMail = vi.fn().mockRejectedValue(
        Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })
      );
      const adapter = new SmtpAdapter({ ...baseConfig, transporter: makeTransporter(sendMail) });

      await expect(adapter.sendEmail('dest@example.com', 'S', 'B')).rejects.toThrow(
        /Failed to send email via SMTP: ETIMEDOUT/
      );
    });

    it('ne laisse jamais passer une erreur silencieusement', async () => {
      const sendMail = vi.fn().mockRejectedValue(new Error('boom'));
      const adapter = new SmtpAdapter({ ...baseConfig, transporter: makeTransporter(sendMail) });

      await expect(adapter.sendEmail('dest@example.com', 'S', 'B')).rejects.toThrow();
    });
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ASSISTANT_NAME } from '../../../src/shared/assistant-identity';
import { createEmailProvider } from '../../../src/features/notification/infrastructure/providers/email-provider.factory';
import { SmtpAdapter } from '../../../src/features/notification/infrastructure/providers/smtp.adapter';
import { BrevoAdapter } from '../../../src/features/notification/infrastructure/providers/brevo.adapter';
import { htmlEmailBody } from '../../../src/features/notification/domain/services/email-body';

/**
 * L'expéditeur affiché d'un email est la SEULE partie de ce produit qu'un
 * destinataire lit avant d'ouvrir quoi que ce soit. Il portait « Kisso Onboarding »
 * — le nom du PROJET — alors que l'assistant s'appelle Marcel depuis le 2026-08-21
 * et se présente ainsi dans Slack. Deux noms pour un seul interlocuteur.
 *
 * ⚠️ Le nom est DÉRIVÉ d'`ASSISTANT_NAME`, jamais recopié. Un littéral de plus
 * serait une seconde source de vérité, et ce dépôt a déjà mesuré la dérive de
 * chacune de ses recopies. Ces tests comparent donc à la constante, pas à
 * « Marcel » : renommer l'assistant renomme l'expéditeur, sans qu'aucun test ne
 * rougisse ni ne doive être réécrit.
 */

const ENV_KEYS = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'BREVO_API_KEY',
  'NOTIFICATION_FROM',
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.unstubAllGlobals();
});

describe("identité de l'expéditeur des emails", () => {
  it('le chemin SMTP signe du nom de l’assistant, pas du nom du projet', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_USER = 'bot@example.com';
    process.env.SMTP_PASS = 'secret';
    process.env.NOTIFICATION_FROM = 'noreply@kisso.com';

    const sendMail = vi.fn().mockResolvedValue({});
    const provider = createEmailProvider();
    expect(provider).toBeInstanceOf(SmtpAdapter);

    // On rebranche le transport sur une doublure : la factory construit un vrai
    // transport nodemailer, et le seul point d'observation du nom est `sendMail`.
    (provider as unknown as { transporter: { sendMail: typeof sendMail } }).transporter = {
      sendMail,
    };

    await provider.sendEmail('dest@example.com', 'Sujet', htmlEmailBody('<p>Corps</p>'));

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: `"${ASSISTANT_NAME}" <noreply@kisso.com>` }),
    );
  });

  it('le chemin Brevo signe du MÊME nom — un basculement de fournisseur ne renomme personne', async () => {
    process.env.BREVO_API_KEY = 'key';
    process.env.NOTIFICATION_FROM = 'noreply@kisso.com';

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    const provider = createEmailProvider();
    expect(provider).toBeInstanceOf(BrevoAdapter);

    await provider.sendEmail('dest@example.com', 'Sujet', htmlEmailBody('<p>Corps</p>'));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.sender).toEqual({ email: 'noreply@kisso.com', name: ASSISTANT_NAME });
  });

  it('aucun chemin d’email ne porte plus « Kisso Onboarding »', async () => {
    const { readFileSync } = await import('node:fs');
    const factory = readFileSync(
      'src/features/notification/infrastructure/providers/email-provider.factory.ts',
      'utf8',
    );

    expect(factory).not.toContain('Kisso Onboarding');
    // Le nom n'est pas non plus recopié en littéral : il est importé.
    expect(factory).toContain('ASSISTANT_NAME');
    expect(factory).not.toMatch(/fromName:\s*'[A-Z]/);
  });

  /**
   * ⚠️ `scripts/smoke-email.mjs` ENVOIE UN VRAI EMAIL, et c'est le seul instrument
   * qui vérifie la chaîne SMTP de bout en bout. Étant du `.mjs` lancé par `node` nu,
   * il ne peut pas importer une constante TypeScript : il recopie le nom. Une recopie
   * non surveillée dérive — ce dépôt l'a mesuré sur la chaîne de modèles, sur
   * `READ_ONLY_TOOL_NAMES` et sur la constante `WIRING` d'un test de budget. Ici la
   * dérive serait silencieuse ET trompeuse : le smoke test signerait d'un nom que la
   * production n'emploie plus, en prétendant mesurer la production.
   */
  it('le smoke test SMTP recopie le nom, et la recopie est vérifiée', async () => {
    const { readFileSync } = await import('node:fs');
    const script = readFileSync('scripts/smoke-email.mjs', 'utf8');

    const declared = /const SENDER_NAME = '([^']+)';/.exec(script);
    expect(declared, 'scripts/smoke-email.mjs doit déclarer SENDER_NAME').not.toBeNull();
    expect(declared![1]).toBe(ASSISTANT_NAME);
    expect(script).not.toContain('Kisso Onboarding');
  });
});

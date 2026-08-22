import { htmlEmailBody } from '../../../src/features/notification/domain/services/email-body';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { BrevoAdapter } from '../../../src/features/notification/infrastructure/providers/brevo.adapter';
import { MAX_EMAIL_ATTACHMENTS_BYTES } from '../../../src/features/notification/domain/services/email-attachment-policy';

/**
 * Brevo est un chemin de REPLI mort en pratique : le compte transactionnel n'est
 * pas activé et `POST /v3/smtp/email` répond `403 permission_denied`. Ces tests ne
 * valident donc pas une fonctionnalité vivante — ils verrouillent la COHÉRENCE de
 * l'adaptateur avec le port `EmailProvider`, faute de quoi la moindre reprise du
 * chemin Brevo enverrait un corps de requête invalide sans que rien ne le signale.
 */

function stubFetch(response: Partial<Response> = {}) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 201,
    text: async () => '',
    ...response,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function bodyOf(fetchMock: ReturnType<typeof stubFetch>): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[0][1].body as string);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BrevoAdapter', () => {
  it("n'ajoute aucune clé `attachment` quand aucune pièce jointe n'est fournie", async () => {
    const fetchMock = stubFetch();
    const adapter = new BrevoAdapter('key', 'noreply@kisso.com');

    await adapter.sendEmail('dest@example.com', 'Sujet', htmlEmailBody('<p>Corps</p>'));

    expect(bodyOf(fetchMock)).not.toHaveProperty('attachment');
  });

  it('encode les pièces jointes en base64 sous la clé `attachment`', async () => {
    // Le champ Brevo s'appelle `attachment` (singulier) et attend `{ content, name }`
    // où `content` est du base64 — pas `attachments` façon nodemailer.
    const fetchMock = stubFetch();
    const adapter = new BrevoAdapter('key', 'noreply@kisso.com');

    await adapter.sendEmail('dest@example.com', 'Guide', htmlEmailBody('<p>Ci-joint</p>'), [
      { filename: 'guide.pdf', bytes: new Uint8Array([1, 2, 3]), mimeType: 'application/pdf' },
    ]);

    expect(bodyOf(fetchMock).attachment).toEqual([
      { content: Buffer.from([1, 2, 3]).toString('base64'), name: 'guide.pdf' },
    ]);
  });

  it('applique la même borne de taille que SMTP', async () => {
    const fetchMock = stubFetch();
    const adapter = new BrevoAdapter('key', 'noreply@kisso.com');

    await expect(
      adapter.sendEmail('dest@example.com', 'Guide', htmlEmailBody('<p>x</p>'), [
        {
          filename: 'guide.pdf',
          bytes: new Uint8Array(MAX_EMAIL_ATTACHMENTS_BYTES + 1),
          mimeType: 'application/pdf',
        },
      ]),
    ).rejects.toThrow(/pièces jointes/i);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

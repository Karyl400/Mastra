/**
 * `generateDocument` — rendu, livraison et REDDITION DE COMPTES.
 *
 * L'outil se réduisait à un `repo.save()`. C'est ce vide qui a produit en production le
 * faux lien `https://kisso.internal/docs/<uuid>/download` : sommé de livrer un document,
 * le modèle a fabriqué la seule chose qu'il savait produire. Ces tests verrouillent les
 * trois propriétés qui referment ce trou :
 *
 *   1. un FICHIER est réellement rendu, au format demandé ;
 *   2. il est LIVRÉ là où la demande a été faite — canal et thread venant du serveur,
 *      adresse email venant de l'annuaire, jamais du modèle ;
 *   3. tout échec de livraison est retourné EXPLICITEMENT au modèle, et le document est
 *      enregistré quand même (règle « ne jamais rendre le bot muet », sans pour autant
 *      reproduire le piège `emailSent: false` sous `status: 'success'`).
 *
 * Le rendu réel (vrais octets PDF/DOCX) est couvert par les tests des services : ici les
 * renderers sont des doublures, sinon chaque cas de livraison paierait une génération PDF.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { makeGenerateDocument } from '../../../src/features/document/application/tools/generate-document';
import { InMemoryDocumentRepository } from '../../../src/features/document/infrastructure/repositories/in-memory-document.repository';
import { InMemoryEmployeeRepository } from '../../../src/features/employee/infrastructure/repositories/in-memory-employee.repository';
import type {
  DocumentRenderInput,
  DocumentRenderer,
  RenderedDocument,
} from '../../../src/features/document/domain/ports/document-renderer';
import type {
  EmailAttachment,
  EmailProvider,
  FileUploadInput,
  FileUploadProvider,
} from '../../../src/features/notification/domain/ports/providers';
import { buildSlackRequestContext } from '../../../src/shared/slack-request-context';
import type { Employee } from '../../../src/features/employee/domain/entities/employee';
import {
  DocumentFormat,
  DocumentStatus,
  DocumentType,
  EmployeeStatus,
} from '../../../src/shared/types';

const EMPLOYEE_ID = '11111111-1111-4111-8111-111111111111';
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';

const employee: Employee = {
  id: EMPLOYEE_ID,
  firstName: 'Karyl',
  lastName: 'SOUMAILA',
  email: 'karylsoumaila1@gmail.com',
  department: 'Engineering',
  position: 'Software Engineer',
  startDate: '2026-09-01T00:00:00.000Z',
  status: EmployeeStatus.Pending,
  managerId: null,
  createdAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
};

/** Renderer factice : enregistre ce qu'on lui demande, rend des octets reconnaissables. */
class FakeRenderer implements DocumentRenderer {
  readonly calls: DocumentRenderInput[] = [];

  constructor(
    readonly format: DocumentFormat,
    private readonly onRender?: () => never,
  ) {}

  async render(input: DocumentRenderInput): Promise<RenderedDocument> {
    this.calls.push(input);
    this.onRender?.();
    return {
      bytes: new Uint8Array([1, 2, 3, 4]),
      filename: `guide.${this.format}`,
      mimeType: `application/${this.format}`,
    };
  }
}

class FakeFileUpload implements FileUploadProvider {
  readonly calls: FileUploadInput[] = [];

  constructor(private readonly failure?: Error) {}

  async uploadFile(input: FileUploadInput): Promise<{ permalink?: string }> {
    this.calls.push(input);
    if (this.failure) throw this.failure;
    return { permalink: 'https://kissohq.slack.com/files/U1/F1/guide.pdf' };
  }
}

class FakeEmail implements EmailProvider {
  readonly calls: Array<{
    to: string;
    subject: string;
    body: string;
    attachments?: EmailAttachment[];
  }> = [];

  constructor(private readonly failure?: Error) {}

  async sendEmail(
    to: string,
    subject: string,
    body: string,
    attachments?: EmailAttachment[],
  ): Promise<void> {
    this.calls.push({ to, subject, body, attachments });
    if (this.failure) throw this.failure;
  }
}

/**
 * Refus Slack tel qu'il arrive RÉELLEMENT au tool : `SlackAdapter.uploadFile` retraduit
 * `missing_scope` en une erreur de prose et conserve l'originale dans `cause`. Un test qui
 * lèverait un `{ data: { error: 'missing_scope' } }` nu ne prouverait rien du chemin réel.
 */
function missingScopeError(): Error {
  const raw = Object.assign(new Error('An API error occurred: missing_scope'), {
    data: { error: 'missing_scope' },
  });
  return new Error(
    'Slack refuse l’upload : le scope `files:write` manque au bot. Action HUMAINE requise…',
    { cause: raw },
  );
}

let documentRepo: InMemoryDocumentRepository;
let employeeRepo: InMemoryEmployeeRepository;
let pdf: FakeRenderer;
let docx: FakeRenderer;

beforeEach(async () => {
  documentRepo = new InMemoryDocumentRepository();
  employeeRepo = new InMemoryEmployeeRepository();
  await employeeRepo.save(employee);
  pdf = new FakeRenderer(DocumentFormat.Pdf);
  docx = new FakeRenderer(DocumentFormat.Docx);
});

interface Overrides {
  renderers?: DocumentRenderer[];
  fileUpload?: FileUploadProvider;
  emailProvider?: EmailProvider;
}

function tool(overrides: Overrides = {}) {
  return makeGenerateDocument({
    documentRepo,
    employeeRepo,
    renderers: overrides.renderers ?? [pdf, docx],
    fileUpload: overrides.fileUpload,
    emailProvider: overrides.emailProvider,
  });
}

type Result = {
  saved: boolean;
  documentId?: string;
  format?: string;
  filename?: string;
  delivery: string;
  reason?: string;
  hint?: string;
};

/** L'appel direct court-circuite Zod : les valeurs par défaut sont donc explicites ici. */
function input(overrides: Record<string, unknown> = {}) {
  return {
    employeeId: EMPLOYEE_ID,
    type: DocumentType.Guide,
    title: 'Guide de démarrage',
    content: 'Bienvenue chez Kisso. Voici les règles internes.',
    format: DocumentFormat.Pdf,
    deliverTo: 'slack',
    ...overrides,
  };
}

function slackCtx(threadTs?: string) {
  return {
    requestContext: buildSlackRequestContext({
      channel: 'C0BJGBVB5HP',
      ...(threadTs ? { threadTs } : {}),
      slackUserId: 'U0BM123',
    }),
  };
}

async function run(overrides: Overrides, data: Record<string, unknown>, ctx: unknown = {}) {
  return (await tool(overrides).execute!(data as never, ctx as never)) as Result;
}

describe('generateDocument — rendu', () => {
  it('demande le rendu au renderer du format demandé (pdf)', async () => {
    const result = await run({}, input({ deliverTo: 'none' }));

    expect(pdf.calls).toHaveLength(1);
    expect(docx.calls).toHaveLength(0);
    expect(result.format).toBe(DocumentFormat.Pdf);
    expect(result.filename).toBe('guide.pdf');
  });

  it('demande le rendu au renderer docx quand docx est demandé', async () => {
    const result = await run({}, input({ format: DocumentFormat.Docx, deliverTo: 'none' }));

    expect(docx.calls).toHaveLength(1);
    expect(pdf.calls).toHaveLength(0);
    expect(result.format).toBe(DocumentFormat.Docx);
  });

  it('transmet au gabarit les données employé issues de l annuaire', async () => {
    await run({}, input({ deliverTo: 'none' }));

    expect(pdf.calls[0]!.employee).toMatchObject({
      firstName: 'Karyl',
      lastName: 'SOUMAILA',
      email: 'karylsoumaila1@gmail.com',
      department: 'Engineering',
      position: 'Software Engineer',
    });
  });

  it('retombe sur le PDF quand le renderer du format demandé n est pas câblé', async () => {
    // Filet de câblage : le schéma promet `docx`, mais rien ne garantit que
    // `src/mastra/index.ts` ait injecté le renderer correspondant. On rend alors un
    // fichier réel plutôt que rien, et le résultat NOMME le format effectivement produit
    // — le modèle peut donc dire la vérité (« je te l'ai fait en PDF »).
    const result = await run(
      { renderers: [pdf] },
      input({ format: DocumentFormat.Docx, deliverTo: 'none' }),
    );

    expect(pdf.calls).toHaveLength(1);
    expect(result.saved).toBe(true);
    expect(result.format).toBe(DocumentFormat.Pdf);

    const [saved] = await documentRepo.findByEmployee(EMPLOYEE_ID);
    expect(saved!.format).toBe(DocumentFormat.Pdf);
  });

  it('refuse un format non rendable par la validation, sans exception ni écriture', async () => {
    // `DocumentFormat` compte dix valeurs, deux seulement ont un renderer. Le schéma
    // n'expose donc que celles-là : Mastra rejette les autres AVANT `execute` et rend au
    // modèle un message qui nomme les valeurs acceptées. Aucune exception ne remonte à
    // l'utilisateur, et rien n'est écrit.
    const result = (await tool().execute!(
      input({ format: DocumentFormat.Csv }) as never,
      {} as never,
    )) as unknown as { error?: boolean; message?: string };

    expect(result.error).toBe(true);
    expect(result.message).toContain("'pdf' | 'docx'");
    expect(pdf.calls).toHaveLength(0);
    expect(await documentRepo.findByEmployee(EMPLOYEE_ID)).toHaveLength(0);
  });

  it('n a aucun renderer câblé : enregistre quand même et le signale', async () => {
    const result = await run({ renderers: [] }, input({ deliverTo: 'none' }));

    expect(result.saved).toBe(true);
    expect(result.reason).toBe('not_rendered');
    expect(await documentRepo.findByEmployee(EMPLOYEE_ID)).toHaveLength(1);
  });

  it('enregistre quand même le document si le rendu échoue', async () => {
    const cassé = new FakeRenderer(DocumentFormat.Pdf, () => {
      throw new Error('pdfmake indisponible');
    });

    const result = await run({ renderers: [cassé] }, input());

    expect(result.saved).toBe(true);
    expect(result.delivery).toBe('none');
    expect(result.reason).toBe('not_rendered');
    expect(result.filename).toBeUndefined();
    expect(await documentRepo.findByEmployee(EMPLOYEE_ID)).toHaveLength(1);
  });
});

describe('generateDocument — livraison Slack', () => {
  it('livre dans le canal ET le thread portés par le requestContext', async () => {
    const upload = new FakeFileUpload();

    const result = await run({ fileUpload: upload }, input(), slackCtx('1723370000.000100'));

    expect(upload.calls).toHaveLength(1);
    expect(upload.calls[0]).toMatchObject({
      channel: 'C0BJGBVB5HP',
      threadTs: '1723370000.000100',
      filename: 'guide.pdf',
    });
    expect(upload.calls[0]!.bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(result.delivery).toBe('slack');
    expect(result.reason).toBeUndefined();
  });

  it('n envoie AUCUN threadTs en DM — le threader enfouirait le fichier', async () => {
    const upload = new FakeFileUpload();

    await run({ fileUpload: upload }, input(), slackCtx());

    expect(upload.calls[0]!.threadTs).toBeUndefined();
    expect('threadTs' in upload.calls[0]!).toBe(false);
  });

  it('ne renvoie jamais le permalink au modèle', async () => {
    // Remettre une URL dans le contexte rouvrirait la porte du faux lien : le fichier est
    // déjà dans le fil, l'agent n'a rien à citer.
    const upload = new FakeFileUpload();

    const result = await run({ fileUpload: upload }, input(), slackCtx());

    expect(JSON.stringify(result)).not.toContain('slack.com');
  });

  it('marque le document Sent quand il est livré', async () => {
    await run({ fileUpload: new FakeFileUpload() }, input(), slackCtx());

    const [saved] = await documentRepo.findByEmployee(EMPLOYEE_ID);
    expect(saved!.status).toBe(DocumentStatus.Sent);
  });

  it('sans contexte Slack : aucun upload, aucune erreur, verdict honnête', async () => {
    // Cas NORMAL du playground Mastra, d'un appel HTTP ou d'un test — pas une panne.
    const upload = new FakeFileUpload();

    const result = await run({ fileUpload: upload }, input(), {});

    expect(upload.calls).toHaveLength(0);
    expect(result.saved).toBe(true);
    expect(result.delivery).toBe('none');
    expect(result.reason).toBe('no_slack_context');
    expect(result.hint).toMatch(/ne promets aucun envoi/i);

    const [saved] = await documentRepo.findByEmployee(EMPLOYEE_ID);
    expect(saved!.status).toBe(DocumentStatus.Generated);
  });

  it('dégrade lisiblement quand aucun fournisseur de fichiers n est câblé', async () => {
    const result = await run({}, input(), slackCtx());

    expect(result.saved).toBe(true);
    expect(result.delivery).toBe('failed');
  });
});

describe('generateDocument — livraison email', () => {
  it('joint le fichier et résout l adresse depuis l annuaire', async () => {
    const email = new FakeEmail();

    const result = await run({ emailProvider: email }, input({ deliverTo: 'email' }));

    expect(email.calls).toHaveLength(1);
    expect(email.calls[0]!.to).toBe('karylsoumaila1@gmail.com');
    expect(email.calls[0]!.attachments).toEqual([
      { filename: 'guide.pdf', bytes: new Uint8Array([1, 2, 3, 4]), mimeType: 'application/pdf' },
    ]);
    expect(result.delivery).toBe('email');
  });

  it('IGNORE toute adresse proposée par le modèle', async () => {
    // Même modèle de menace que `send-notification.ts` : l'outil est atteignable depuis un
    // message Slack arbitraire, une adresse produite par le LLM est réputée hostile.
    const email = new FakeEmail();

    await run(
      { emailProvider: email },
      input({ deliverTo: 'email', to: 'attaquant@example.com', recipientEmail: 'x@example.com' }),
    );

    expect(email.calls[0]!.to).toBe('karylsoumaila1@gmail.com');
  });

  it('rend delivery=failed et enregistre quand même quand le SMTP échoue', async () => {
    const email = new FakeEmail(new Error('ETIMEDOUT'));

    const result = await run({ emailProvider: email }, input({ deliverTo: 'email' }));

    expect(result.saved).toBe(true);
    expect(result.delivery).toBe('failed');
    expect(result.reason).toBe('delivery_failed');
    expect(result.hint).toMatch(/non livré/i);

    const [saved] = await documentRepo.findByEmployee(EMPLOYEE_ID);
    expect(saved!.status).toBe(DocumentStatus.Generated);
  });

  it('rend delivery=failed sans adresse en annuaire', async () => {
    await employeeRepo.save({ ...employee, email: '' });
    const email = new FakeEmail();

    const result = await run({ emailProvider: email }, input({ deliverTo: 'email' }));

    expect(email.calls).toHaveLength(0);
    expect(result.delivery).toBe('failed');
    expect(result.reason).toBe('no_email');
  });
});

describe('generateDocument — scope files:write absent', () => {
  it('replie sur l email quand Slack refuse pour missing_scope', async () => {
    const upload = new FakeFileUpload(missingScopeError());
    const email = new FakeEmail();

    const result = await run(
      { fileUpload: upload, emailProvider: email },
      input(),
      slackCtx('1723370000.000100'),
    );

    expect(email.calls).toHaveLength(1);
    expect(email.calls[0]!.to).toBe('karylsoumaila1@gmail.com');
    expect(result.delivery).toBe('email');
  });

  it('dégrade lisiblement — et enregistre — quand le repli email est impossible', async () => {
    const upload = new FakeFileUpload(missingScopeError());

    const result = await run({ fileUpload: upload }, input(), slackCtx());

    expect(result.saved).toBe(true);
    expect(result.delivery).toBe('failed');
    expect(result.reason).toBe('missing_scope');
    expect(result.hint).toMatch(/non livré/i);
    expect(await documentRepo.findByEmployee(EMPLOYEE_ID)).toHaveLength(1);
  });

  it('ne replie PAS sur l email pour une panne Slack ordinaire', async () => {
    // Un échec transitoire ne justifie pas d'écrire à quelqu'un qui n'a rien demandé.
    const upload = new FakeFileUpload(new Error('An API error occurred: not_in_channel'));
    const email = new FakeEmail();

    const result = await run({ fileUpload: upload, emailProvider: email }, input(), slackCtx());

    expect(email.calls).toHaveLength(0);
    expect(result.delivery).toBe('failed');
    expect(result.reason).toBe('delivery_failed');
  });
});

describe('generateDocument — garde-fous', () => {
  it('ne génère ni n enregistre rien pour un employé inconnu, et instruit le modèle', async () => {
    const upload = new FakeFileUpload();

    const result = await run({ fileUpload: upload }, input({ employeeId: UNKNOWN_ID }), slackCtx());

    expect(result.saved).toBe(false);
    expect(result.reason).toBe('employee_not_found');
    expect(result.hint).toMatch(/findEmployeeByEmail/);
    expect(pdf.calls).toHaveLength(0);
    expect(upload.calls).toHaveLength(0);
    expect(await documentRepo.findByEmployee(UNKNOWN_ID)).toHaveLength(0);
  });

  it('deliverTo=none : rien n est envoyé, et ce n est pas un échec', async () => {
    const upload = new FakeFileUpload();
    const email = new FakeEmail();

    const result = await run(
      { fileUpload: upload, emailProvider: email },
      input({ deliverTo: 'none' }),
      slackCtx(),
    );

    expect(upload.calls).toHaveLength(0);
    expect(email.calls).toHaveLength(0);
    expect(result.delivery).toBe('none');
    expect(result.reason).toBeUndefined();
  });

  it('par défaut : PDF, livré dans Slack — les deux champs sont omissibles', async () => {
    // `txt` était le défaut historique : le modèle devait DEVINER qu'il fallait demander
    // autre chose pour obtenir ce que tout le monde attend d'un document, un PDF.
    const upload = new FakeFileUpload();

    const result = await run(
      { fileUpload: upload },
      {
        employeeId: EMPLOYEE_ID,
        type: DocumentType.Guide,
        title: 'Guide de démarrage',
        content: 'Bienvenue chez Kisso.',
      },
      slackCtx(),
    );

    expect(pdf.calls).toHaveLength(1);
    expect(docx.calls).toHaveLength(0);
    expect(result.format).toBe(DocumentFormat.Pdf);
    expect(upload.calls).toHaveLength(1);
    expect(result.delivery).toBe('slack');
  });
});

describe('generateDocument — journalisation des échecs', () => {
  it('journalise en error, jamais en silence', async () => {
    const { logger } = await import('../../../src/shared/logger');
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);

    await run({ fileUpload: new FakeFileUpload(missingScopeError()) }, input(), slackCtx());

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

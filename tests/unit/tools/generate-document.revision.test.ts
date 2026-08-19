/**
 * ════════════════════════════════════════════════════════════════════════════
 * CORRIGER un document, plutôt qu'en produire un second — 2026-08-19
 * ════════════════════════════════════════════════════════════════════════════
 *
 * La cause de fond est écrite depuis le 2026-08-12 dans l'en-tête de la garde
 * d'idempotence, et elle n'avait jamais été traitée :
 *
 *   « le système ne sait que CRÉER — il n'existe aucun outil de relecture de document, donc
 *     refaire est la seule action que le modèle puisse entreprendre quand on lui demande
 *     "où en est-ce ?" »
 *
 * D'où les **7 documents et 3 emails identiques en 8 minutes** de cette date. La garde a
 * étouffé le symptôme ; ce champ referme la cause : « corrige la deuxième phrase » a désormais
 * une action correspondante.
 *
 * ⚠️ UN CHAMP OPTIONNEL, JAMAIS UN SECOND TOOL. Un tool de plus est un schéma de plus réémis
 * à CHAQUE aller-retour de l'agent qui le porte ; un champ optionnel coûte une vingtaine de
 * tokens. Le poste de coût dominant de ce dépôt est le nombre d'étapes, pas la prose.
 *
 * ⚠️ ET UN BOOLÉEN, JAMAIS UN UUID — corrigé le même jour, par une mesure en production.
 * La première version attendait l'identifiant rendu par le tool-result précédent. Or la
 * mémoire de ce dépôt ne stocke QUE DU TEXTE, « jamais de tool-call ni de tool-result » : au
 * message suivant — le seul cas qui compte, « corrige ce guide » — le modèle ne l'avait plus,
 * et il l'a demandé à l'humain : « il me faut l'UUID du document existant ». Le SERVEUR sait,
 * lui. C'est la règle appliquée partout ailleurs ici : le canal, le fil, l'adresse et
 * l'identifiant du demandeur ne traversent jamais la fenêtre du modèle.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { makeGenerateDocument } from '../../../src/features/document/application/tools/generate-document';
import { InMemoryDocumentRepository } from '../../../src/features/document/infrastructure/repositories/in-memory-document.repository';
import { InMemoryEmployeeRepository } from '../../../src/features/employee/infrastructure/repositories/in-memory-employee.repository';
import type {
  DocumentRenderInput,
  DocumentRenderer,
  RenderedDocument,
} from '../../../src/features/document/domain/ports/document-renderer';
import type {
  FileUploadInput,
  FileUploadProvider,
} from '../../../src/features/notification/domain/ports/providers';
import { buildSlackRequestContext } from '../../../src/shared/slack-request-context';
import type { Employee } from '../../../src/features/employee/domain/entities/employee';
import { DocumentFormat, DocumentType, EmployeeStatus } from '../../../src/shared/types';

const EMPLOYEE_ID = '11111111-1111-4111-8111-111111111111';
const AUTRE_ID = '22222222-2222-4222-8222-222222222222';

function person(id: string, firstName: string): Employee {
  return {
    id,
    firstName,
    lastName: 'SOUMAILA',
    email: `${firstName.toLowerCase()}@kisso.com`,
    department: 'Engineering',
    position: 'Software Engineer',
    startDate: '2026-09-01T00:00:00.000Z',
    status: EmployeeStatus.Pending,
    managerId: null,
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
  };
}

class FakeRenderer implements DocumentRenderer {
  readonly calls: DocumentRenderInput[] = [];
  constructor(readonly format: DocumentFormat) {}
  async render(input: DocumentRenderInput): Promise<RenderedDocument> {
    this.calls.push(input);
    return {
      bytes: new Uint8Array([1, 2, 3, 4]),
      filename: `guide.${this.format}`,
      mimeType: `application/${this.format}`,
    };
  }
}

class FakeFileUpload implements FileUploadProvider {
  readonly calls: FileUploadInput[] = [];
  async uploadFile(input: FileUploadInput): Promise<{ permalink?: string }> {
    this.calls.push(input);
    return { permalink: 'https://kissohq.slack.com/files/U1/F1/guide.pdf' };
  }
}

let documentRepo: InMemoryDocumentRepository;
let employeeRepo: InMemoryEmployeeRepository;
let pdf: FakeRenderer;
let upload: FakeFileUpload;

beforeEach(async () => {
  documentRepo = new InMemoryDocumentRepository();
  employeeRepo = new InMemoryEmployeeRepository();
  await employeeRepo.save(person(EMPLOYEE_ID, 'Karyl'));
  await employeeRepo.save(person(AUTRE_ID, 'Awa'));
  pdf = new FakeRenderer(DocumentFormat.Pdf);
  upload = new FakeFileUpload();
});

function tool() {
  return makeGenerateDocument({
    documentRepo,
    employeeRepo,
    renderers: [pdf],
    fileUpload: upload,
  });
}

type Result = {
  saved: boolean;
  revised?: boolean;
  documentId?: string;
  delivery: string;
  reason?: string;
  hint?: string;
};

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

/** Chaque appel porte son propre `eventTs` : la garde d'idempotence borne le MESSAGE. */
function slackCtx(eventTs: string) {
  return {
    requestContext: buildSlackRequestContext({
      channel: 'C0BJGBVB5HP',
      slackUserId: 'U0BM123',
      eventTs,
    }),
  };
}

describe('corriger un document existant', () => {
  it('REMPLACE la ligne au lieu d’en créer une seconde', async () => {
    const t = tool();
    const premier = (await t.execute!(input() as never, slackCtx('1.1') as never)) as Result;
    expect(premier.saved).toBe(true);

    const corrige = (await t.execute!(
      input({
        revises: true,
        content: 'Bienvenue chez Kisso. Le bureau ouvre à 8h, pas à 9h.',
      }) as never,
      slackCtx('2.2') as never,
    )) as Result;

    expect(corrige.revised).toBe(true);
    // ⚠️ LE MÊME identifiant : c'est toute la propriété. Un nouvel UUID ferait de « corrige »
    // un synonyme de « refais », c'est-à-dire exactement le défaut du 2026-08-12.
    expect(corrige.documentId).toBe(premier.documentId);

    const toutes = await documentRepo.findByEmployee(EMPLOYEE_ID);
    expect(toutes).toHaveLength(1);
    expect(toutes[0]!.content).toContain('8h');
  });

  it('RELIVRE le document corrigé — une correction que personne ne reçoit n’en est pas une', async () => {
    const t = tool();
    const premier = (await t.execute!(input() as never, slackCtx('1.1') as never)) as Result;

    const corrige = (await t.execute!(
      input({ revises: true, content: 'Texte corrigé.' }) as never,
      slackCtx('2.2') as never,
    )) as Result;

    expect(corrige.delivery).toBe('slack');
    expect(upload.calls).toHaveLength(2);
  });

  it('la GARDE d’idempotence ne bloque pas une correction', async () => {
    // La clé de déduplication porte le titre, le type et le format — inchangés par une
    // correction de contenu. Sans traitement particulier, la correction serait rejetée comme
    // un doublon et le modèle annoncerait avoir corrigé sans que rien ne bouge.
    const t = tool();
    const premier = (await t.execute!(input() as never, slackCtx('1.1') as never)) as Result;

    const corrige = (await t.execute!(
      input({ revises: true, content: 'Autre texte.' }) as never,
      slackCtx('2.2') as never,
    )) as Result;

    expect(corrige.revised).toBe(true);
    expect((corrige as { alreadyDelivered?: boolean }).alreadyDelivered).toBeUndefined();
  });

  it('REFUSE quand il n’y a rien à corriger — sans rien créer', async () => {
    // ⚠️ Ne PAS retomber sur une création : le modèle annoncerait « j'ai corrigé » alors
    // qu'il vient de produire un PREMIER document. C'est la famille de mensonge que tout ce
    // dépôt traque, avec la particularité que le repli la fabriquerait lui-même.
    const t = tool();
    const out = (await t.execute!(
      input({ revises: true }) as never,
      slackCtx('1.1') as never,
    )) as Result;

    expect(out.saved).toBe(false);
    expect(out.reason).toBe('document_not_found');
    expect(await documentRepo.findByEmployee(EMPLOYEE_ID)).toHaveLength(0);
  });

  it('ne corrige JAMAIS le document d’une autre personne', async () => {
    // ⚠️ La cible est résolue depuis `employeeId`, lui-même déjà passé par
    // `canReadPersonRecord`. Il n'y a donc aucun identifiant produit par le modèle sur ce
    // chemin — et donc rien à faire fuiter : l'ORACLE d'existence que la première version
    // devait neutraliser à la main n'existe tout simplement plus.
    const t = tool();
    await t.execute!(input({ employeeId: AUTRE_ID }) as never, slackCtx('1.1') as never);

    const out = (await t.execute!(
      input({ revises: true }) as never,
      slackCtx('2.2') as never,
    )) as Result;

    expect(out.saved).toBe(false);
    expect(out.reason).toBe('document_not_found');
    expect(await documentRepo.findByEmployee(AUTRE_ID)).toHaveLength(1);
  });

  it('corrige le PLUS RÉCENT du même type, jamais un plus ancien ni un autre type', async () => {
    const t = tool();
    await t.execute!(
      input({ type: DocumentType.WelcomeLetter, title: 'Bienvenue' }) as never,
      slackCtx('1.1') as never,
    );
    const guide = (await t.execute!(input() as never, slackCtx('2.2') as never)) as Result;

    const corrige = (await t.execute!(
      input({ revises: true, content: 'Corrigé.' }) as never,
      slackCtx('3.3') as never,
    )) as Result;

    expect(corrige.documentId).toBe(guide.documentId);
    // La lettre de bienvenue n'a pas bougé, et rien n'a été créé.
    expect(await documentRepo.findByEmployee(EMPLOYEE_ID)).toHaveLength(2);
  });

  it('sans `revises`, rien ne change — chaque appel crée', async () => {
    const t = tool();
    const a = (await t.execute!(input() as never, slackCtx('1.1') as never)) as Result;
    const b = (await t.execute!(
      input({ title: 'Autre guide' }) as never,
      slackCtx('2.2') as never,
    )) as Result;

    expect(a.documentId).not.toBe(b.documentId);
    expect(await documentRepo.findByEmployee(EMPLOYEE_ID)).toHaveLength(2);
    expect(a).not.toHaveProperty('revised');
  });
});

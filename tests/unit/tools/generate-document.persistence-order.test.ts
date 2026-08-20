/**
 * L'ORDRE PERSISTANCE / LIVRAISON — un document ne doit jamais être livré avant d'exister.
 *
 * Défaut relevé le 2026-08-20 : `deliver()` était appelé AVANT `persistDocument()`. Le
 * commentaire au-dessus disait vrai — l'enregistrement a bien lieu quel que soit le VERDICT
 * de livraison — mais il ne disait rien de l'ORDRE, et c'est l'ordre qui décide de ce qui
 * survit à une mort du processus.
 *
 * Sur Vercel, la fonction peut être gelée ou tuée à `maxDuration` (60 s) à n'importe quel
 * instant. Entre les deux appels, l'état atteignable était :
 *
 *   - le PDF est réellement dans Slack ou dans une boîte mail,
 *   - il n'existe AUCUNE ligne en base.
 *
 * Trois conséquences, toutes déjà connues de ce dépôt sous d'autres noms :
 *   - `revises` ne retrouve pas la cible et ne peut plus corriger ;
 *   - une reprise produit un SECOND document — la famille du défaut « 7 documents et
 *     3 emails identiques en 8 minutes » du 2026-08-19 ;
 *   - l'audit sous-compte : un document parti dont rien ne garde la trace.
 *
 * ⚠️ La garde d'idempotence ne rattrape rien ici : `runGuard.remember` est appelé APRÈS les
 * deux, et c'est une `Map` en mémoire de processus — elle meurt avec l'instance.
 *
 * L'ordre inverse (persister puis livrer) a un pire cas STRICTEMENT moins coûteux : une
 * ligne `Generated` sans fichier livré. Elle est visible, corrigible, et `revises` sait la
 * retrouver. C'est le même arbitrage que `clear()` avant l'envoi de l'email d'entretien :
 * on prend d'abord, on agit ensuite.
 */
import { describe, it, expect } from 'vitest';

import { makeGenerateDocument } from '../../../src/features/document/application/tools/generate-document';
import { InMemoryDocumentRepository } from '../../../src/features/document/infrastructure/repositories/in-memory-document.repository';
import { InMemoryEmployeeRepository } from '../../../src/features/employee/infrastructure/repositories/in-memory-employee.repository';
import type { DocumentRenderer } from '../../../src/features/document/domain/ports/document-renderer';
import type { Employee } from '../../../src/features/employee/domain/entities/employee';
import { buildSlackRequestContext } from '../../../src/shared/slack-request-context';
import {
  EmployeeStatus,
  DocumentFormat,
  DocumentType,
  DocumentStatus,
} from '../../../src/shared/types';

const EMPLOYEE_ID = '11111111-1111-4111-8111-111111111111';

/** Même forme que dans `generate-document.test.ts` : les trois clés sont le contrat. */
function slackCtx() {
  // `accessLevel: 'full'` : ce fichier teste l'ORDRE persistance/livraison, pas la
  // frontière. Un contexte Slack sans décision vaut refus depuis le 2026-08-20.
  return buildSlackRequestContext({
    channel: 'C0BJGBVB5HP',
    slackUserId: 'U0BM123',
    accessLevel: 'full',
  });
}

const employee: Employee = {
  id: EMPLOYEE_ID,
  firstName: 'Karyl',
  lastName: 'SOUMAILA',
  email: 'karylsoumaila1@gmail.com',
  department: null,
  position: 'Software Engineer',
  startDate: '2026-09-01T00:00:00.000Z',
  status: EmployeeStatus.Pending,
  managerId: null,
  createdAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
};

const renderer: DocumentRenderer = {
  format: DocumentFormat.Pdf,
  async render() {
    return {
      bytes: new Uint8Array([1, 2, 3]),
      filename: 'guide.pdf',
      mimeType: 'application/pdf',
    };
  },
};

async function setup(onUpload: () => Promise<void>) {
  const documentRepo = new InMemoryDocumentRepository();
  const employeeRepo = new InMemoryEmployeeRepository();
  await employeeRepo.save(employee);

  const tool = makeGenerateDocument({
    documentRepo,
    employeeRepo,
    renderers: [renderer],
    fileUpload: {
      async uploadFile() {
        await onUpload();
        return { permalink: 'https://kissohq.slack.com/f/x' };
      },
    } as never,
  });

  return { tool, documentRepo };
}

describe("generate-document — le document existe AVANT d'être livré", () => {
  it('a déjà sa ligne en base au moment où la livraison commence', async () => {
    // LE test de ce fichier. La doublure de livraison INTERROGE le dépôt au moment exact où
    // elle est appelée : si la ligne n'y est pas encore, un gel à cet instant perdrait
    // définitivement la trace d'un fichier réellement parti.
    let rowsAtDeliveryTime = -1;

    const { tool, documentRepo } = await setup(async () => {
      rowsAtDeliveryTime = (await documentRepo.findByEmployee(EMPLOYEE_ID)).length;
    });

    await tool.execute!(
      {
        employeeId: EMPLOYEE_ID,
        type: DocumentType.Guide,
        title: 'Guide de démarrage',
        content: 'Bienvenue chez Kisso.',
        format: DocumentFormat.Pdf,
        deliverTo: 'slack',
      } as never,
      { requestContext: slackCtx() } as never,
    );

    expect(rowsAtDeliveryTime).toBe(1);
  });

  it('marque `Sent` une fois la livraison réussie — la seule trace persistée du départ', async () => {
    const { tool, documentRepo } = await setup(async () => undefined);

    const result = (await tool.execute!(
      {
        employeeId: EMPLOYEE_ID,
        type: DocumentType.Guide,
        title: 'Guide de démarrage',
        content: 'Bienvenue chez Kisso.',
        format: DocumentFormat.Pdf,
        deliverTo: 'slack',
      } as never,
      { requestContext: slackCtx() } as never,
    )) as { delivery: string };

    expect(result.delivery).toBe('slack');

    const [stored] = await documentRepo.findByEmployee(EMPLOYEE_ID);
    expect(stored.status).toBe(DocumentStatus.Sent);
  });

  it("garde le document en `Generated` quand la livraison échoue — rien n'est perdu", async () => {
    const { tool, documentRepo } = await setup(async () => {
      throw new Error('not_in_channel');
    });

    const result = (await tool.execute!(
      {
        employeeId: EMPLOYEE_ID,
        type: DocumentType.Guide,
        title: 'Guide de démarrage',
        content: 'Bienvenue chez Kisso.',
        format: DocumentFormat.Pdf,
        deliverTo: 'slack',
      } as never,
      { requestContext: slackCtx() } as never,
    )) as { delivery: string; documentId: string };

    expect(result.delivery).toBe('failed');

    const [stored] = await documentRepo.findByEmployee(EMPLOYEE_ID);
    expect(stored.status).toBe(DocumentStatus.Generated);
    // La ligne existe, donc une nouvelle tentative est possible et `revises` sait la cibler.
    expect(stored.id).toBe(result.documentId);
  });
});

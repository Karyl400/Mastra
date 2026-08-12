/**
 * Anti-régression du doublon de PDF mesuré en production le 2026-08-12 à 19:42 UTC.
 *
 * Un seul message Slack, et cette trace :
 *
 *   toolCalls: ["generateDocument","findEmployeeByEmail","getEmployeeProfile","generateDocument"]
 *   steps: 3
 *
 * → deux lignes dans `documents` (`3f1399e2…`, `d05ff0cf…`), deux uploads Slack, deux
 * pièces jointes dans le fil, pour une seule réponse texte. Signalé par le propriétaire
 * comme « il envoie deux fois le même PDF pour une seule requête ».
 *
 * ⚠️ Le point qui fait tout l'intérêt du test : les deux appels de l'incident avaient un
 * `content` DIFFÉRENT (15 puis 249 caractères — le modèle a étoffé son texte). Une garde
 * qui hacherait tous les arguments n'aurait rien attrapé. Le second cas ci-dessous
 * verrouille précisément cela.
 */
import { describe, it, expect, vi } from 'vitest';
import { makeGenerateDocument } from '../../../src/features/document/application/tools/generate-document';
import { buildSlackRequestContext } from '../../../src/shared/slack-request-context';

const EMPLOYEE = {
  id: 'd20df236-5c24-42a5-b205-d0d738d34fb4',
  firstName: 'Karyl',
  lastName: 'SOUMAILA',
  email: 'karylsoumaila1@gmail.com',
  department: 'Engineering',
  position: 'Software Engineer',
  status: 'pending',
};

function makeDeps() {
  const upload = vi.fn(async () => ({ permalink: 'https://slack/x' }));
  const save = vi.fn(async () => {});
  return {
    upload,
    save,
    deps: {
      documentRepo: { save, findById: async () => null, findByEmployee: async () => [] },
      employeeRepo: { findById: async () => EMPLOYEE },
      // `renderers` est une LISTE : c'est le renderer qui DÉCLARE son format.
      renderers: [
        {
          format: 'pdf',
          render: async () => ({
            bytes: new Uint8Array([1, 2, 3]),
            filename: 'lettre-de-bienvenue.pdf',
            mimeType: 'application/pdf',
          }),
        },
      ],
      fileUpload: { uploadFile: upload },
      emailProvider: undefined,
    },
  };
}

/** Le contexte d'un message Slack précis — DM, donc sans `thread_ts`, comme l'incident. */
function slackRun(eventTs: string) {
  return {
    requestContext: buildSlackRequestContext({ channel: 'D0BM9MK9QJV', eventTs }),
  };
}

const INPUT = {
  employeeId: 'd20df236-5c24-42a5-b205-d0d738d34fb4',
  type: 'welcome_letter',
  title: 'Lettre de bienvenue',
  format: 'pdf',
  deliverTo: 'slack',
};

describe('generateDocument — garde d’idempotence par run', () => {
  it('un second appel identique dans le MÊME run ne livre pas un second fichier', async () => {
    const { upload, save, deps } = makeDeps();
    const tool = makeGenerateDocument(deps as never);
    const ctx = slackRun('1786563757.000001');

    const first = (await tool.execute!(
      { ...INPUT, content: 'Bienvenue.' } as never,
      ctx as never,
    )) as Record<string, unknown>;
    const second = (await tool.execute!(
      { ...INPUT, content: 'Bienvenue.' } as never,
      ctx as never,
    )) as Record<string, unknown>;

    expect(upload).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(second.alreadyDelivered).toBe(true);
    expect(second.documentId).toBe(first.documentId);
  });

  it('mord même quand le CONTENU diffère — c’est le cas réel de l’incident', async () => {
    const { upload, deps } = makeDeps();
    const tool = makeGenerateDocument(deps as never);
    const ctx = slackRun('1786563757.000002');

    await tool.execute!({ ...INPUT, content: 'Bienvenue.' } as never, ctx as never);
    const second = (await tool.execute!(
      {
        ...INPUT,
        content:
          'Bienvenue chez Kisso ! Voici les infos clés pour bien démarrer : ton équipe, ' +
          'ton manager, tes accès et tes premières tâches.',
      } as never,
      ctx as never,
    )) as Record<string, unknown>;

    expect(upload).toHaveBeenCalledTimes(1);
    expect(second.alreadyDelivered).toBe(true);
  });

  it('ne bloque PAS un document demandé dans un autre message du même DM', async () => {
    // Le piège que `eventTs` évite : en DM il n'y a pas de `thread_ts`, donc une garde
    // portée par le seul canal aurait refusé ce second document, légitime.
    const { upload, deps } = makeDeps();
    const tool = makeGenerateDocument(deps as never);

    await tool.execute!(
      { ...INPUT, content: 'Bienvenue.' } as never,
      slackRun('1786563757.000003') as never,
    );
    const later = (await tool.execute!(
      { ...INPUT, content: 'Bienvenue.' } as never,
      slackRun('1786564999.000003') as never,
    )) as Record<string, unknown>;

    expect(upload).toHaveBeenCalledTimes(2);
    expect(later.alreadyDelivered).toBeUndefined();
  });

  it('ne bloque pas deux documents DIFFÉRENTS dans le même run', async () => {
    const { upload, deps } = makeDeps();
    const tool = makeGenerateDocument(deps as never);
    const ctx = slackRun('1786563757.000004');

    await tool.execute!({ ...INPUT, content: 'A' } as never, ctx as never);
    const other = (await tool.execute!(
      { ...INPUT, type: 'guide', title: "Guide d'accueil", content: 'B' } as never,
      ctx as never,
    )) as Record<string, unknown>;

    expect(upload).toHaveBeenCalledTimes(2);
    expect(other.alreadyDelivered).toBeUndefined();
  });

  it('hors Slack (playground, workflow, test), la garde est INACTIVE', async () => {
    // Sans run à borner, se rabattre sur une clé constante ferait qu'un second appel
    // dans un tout autre contexte récupérerait le résultat du premier.
    const { upload, deps } = makeDeps();
    const tool = makeGenerateDocument(deps as never);

    await tool.execute!({ ...INPUT, deliverTo: 'none', content: 'A' } as never, {} as never);
    await tool.execute!({ ...INPUT, deliverTo: 'none', content: 'A' } as never, {} as never);

    expect(upload).not.toHaveBeenCalled();
  });
});

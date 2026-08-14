import { describe, it, expect, vi } from 'vitest';

import { buildDocumentOutline } from '../../../src/features/document/domain/services/document-template';
import { makeGenerateDocument } from '../../../src/features/document/application/tools/generate-document';
import { InMemoryDocumentRepository } from '../../../src/features/document/infrastructure/repositories/in-memory-document.repository';
import { InMemoryOnboardingInterviewRepository } from '../../../src/features/onboarding/infrastructure/repositories/in-memory-onboarding-interview.repository';
import { DocumentFormat, DocumentType } from '../../../src/shared/types';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * « Le guide doit être chaleureux, avec les infos connues, sans donnée générique »
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Jusqu'au 2026-08-14, `buildGuide` sortait quatre puces écrites en dur — « Configuration
 * poste de travail », « Accès Slack/GitHub », « Présentation équipe », « Culture
 * entreprise » — IDENTIQUES dans le guide de chaque personne, et ne renvoyant à aucune
 * procédure existante. C'est littéralement le « document générique » signalé.
 *
 * Elles sont remplacées par ce que la personne a dit d'elle à l'entretien. La propriété qui
 * compte : **c'est le GABARIT qui l'imprime**, pas le modèle. Donc zéro token, et impossible
 * à halluciner ou à reformuler.
 */

const EMPLOYEE_ID = 'd36b78dc-a039-4160-b86a-bd3d2a722b6c';

const employee = {
  id: EMPLOYEE_ID,
  firstName: 'Awa',
  lastName: 'TRAORE',
  email: 'awa.traore@kisso.com',
  department: null,
  position: 'Backend Developer',
  startDate: '2026-10-01T00:00:00.000Z',
  status: 'pending',
  managerId: null,
};

function textOf(blocks: ReturnType<typeof buildDocumentOutline>['blocks']): string {
  return blocks
    .map((block) => {
      if (block.kind === 'bullets') return block.items.join(' ');
      if (block.kind === 'fields') return block.rows.map((row) => row.join(' ')).join(' ');
      return block.text;
    })
    .join('\n');
}

describe('buildDocumentOutline — matière de l entretien', () => {
  const base = {
    type: DocumentType.Guide,
    title: 'Guide d’accueil',
    content: 'Bienvenue chez Kisso.',
    employee: { firstName: 'Awa', lastName: 'TRAORE', position: 'Backend Developer' },
  };

  it('imprime le quotidien, la façon de travailler et les canaux', () => {
    const outline = buildDocumentOutline({
      ...base,
      interview: {
        dailyWork: 'je développe les API paiement',
        workStyle: 'je préfère l’écrit aux réunions',
        channels: ['kisso-hq', 'engineering-chat'],
      },
    });
    const texte = textOf(outline.blocks);

    expect(texte).toContain('je développe les API paiement');
    expect(texte).toContain('je préfère l’écrit aux réunions');
    expect(texte).toContain('#kisso-hq');
    expect(texte).toContain('#engineering-chat');
  });

  it('n’ÉMET aucune section pour un champ vide', () => {
    // Un intertitre suivi du vide se lit comme un oubli, pas comme une absence de réponse.
    // Défaut exact qui a fait retirer « Département : N/A » de la lettre de bienvenue.
    const outline = buildDocumentOutline({
      ...base,
      interview: { dailyWork: 'je développe les API paiement', workStyle: '  ', channels: [] },
    });
    const texte = textOf(outline.blocks);

    expect(texte).toContain('Ton quotidien');
    expect(texte).not.toContain('Ta façon de travailler');
    expect(texte).not.toContain('Tes canaux');
  });

  it('rend EXACTEMENT le document d’avant quand il n’y a pas d’entretien', () => {
    // Garantie de non-régression : la personne qui n'a pas répondu ne perd rien.
    const sans = textOf(buildDocumentOutline(base).blocks);
    const vide = textOf(buildDocumentOutline({ ...base, interview: undefined }).blocks);

    expect(vide).toBe(sans);
  });

  it('ne réintroduit PAS les quatre puces génériques', () => {
    // Garde-fou de non-retour. Elles reviendraient à la première relecture qui les
    // trouverait « utiles » — c'est ce qui les avait fait écrire.
    const texte = textOf(buildDocumentOutline({ ...base, interview: { dailyWork: 'x' } }).blocks);

    expect(texte).not.toContain('Configuration poste de travail');
    expect(texte).not.toContain('Présentation équipe');
    expect(texte).not.toContain('Culture entreprise');
  });
});

describe('generateDocument — résolution de l entretien côté serveur', () => {
  const renderer = () => {
    const calls: Array<Record<string, unknown>> = [];
    return {
      calls,
      renderer: {
        format: DocumentFormat.Pdf,
        render: vi.fn(async (input: Record<string, unknown>) => {
          calls.push(input);
          return {
            bytes: new Uint8Array([1, 2, 3]),
            filename: 'guide.pdf',
            mimeType: 'application/pdf',
          };
        }),
      },
    };
  };

  const input = {
    employeeId: EMPLOYEE_ID,
    type: DocumentType.Guide,
    title: 'Guide d’accueil',
    content: 'Bienvenue.',
    format: DocumentFormat.Pdf,
    deliverTo: 'none',
  };

  it('passe l entretien au renderer, canaux résolus en NOMS', async () => {
    // La base stocke des `C…`, qui ne se lisent pas. Le nom est résolu côté serveur.
    const interviewRepo = new InMemoryOnboardingInterviewRepository();
    await interviewRepo.save({
      employeeId: EMPLOYEE_ID,
      slackUserId: 'U0AWA',
      channels: ['CMLKC4S5T', 'C0INCONNU'],
      dailyWork: 'je développe les API paiement',
      workStyle: '',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const { calls, renderer: pdf } = renderer();
    const tool = makeGenerateDocument({
      documentRepo: new InMemoryDocumentRepository(),
      employeeRepo: { findById: vi.fn().mockResolvedValue(employee) },
      renderers: [pdf],
      interviewRepo,
      channelRepo: {
        listChannels: vi.fn().mockResolvedValue([{ channelId: 'CMLKC4S5T', name: 'kisso-hq' }]),
      },
    } as never);

    await tool.execute!(input as never, {} as never);

    expect(calls[0]!.interview).toEqual({
      dailyWork: 'je développe les API paiement',
      workStyle: '',
      // `C0INCONNU` est ÉCARTÉ : « #C0INCONNU » dans un document d'accueil est pire qu'une
      // ligne en moins.
      channels: ['kisso-hq'],
    });
  });

  it('produit quand même le document si la mémoire de l entretien est en panne', async () => {
    // Un guide sans section « ton quotidien » reste un guide. Un guide qui n'existe pas
    // parce que la table n'a pas encore été appliquée serait une régression franche.
    const { calls, renderer: pdf } = renderer();
    const tool = makeGenerateDocument({
      documentRepo: new InMemoryDocumentRepository(),
      employeeRepo: { findById: vi.fn().mockResolvedValue(employee) },
      renderers: [pdf],
      interviewRepo: {
        findByEmployee: vi.fn().mockRejectedValue(new Error('no such table: onboarding_interview')),
      },
    } as never);

    const result = (await tool.execute!(input as never, {} as never)) as { saved: boolean };

    expect(result.saved).toBe(true);
    expect(calls[0]!.interview).toBeUndefined();
  });

  it('n exige PAS le dépôt d entretien', async () => {
    // Dépendance optionnelle : sans elle, le document est exactement celui d'avant.
    const { calls, renderer: pdf } = renderer();
    const tool = makeGenerateDocument({
      documentRepo: new InMemoryDocumentRepository(),
      employeeRepo: { findById: vi.fn().mockResolvedValue(employee) },
      renderers: [pdf],
    } as never);

    const result = (await tool.execute!(input as never, {} as never)) as { saved: boolean };

    expect(result.saved).toBe(true);
    expect(calls[0]!.interview).toBeUndefined();
  });
});

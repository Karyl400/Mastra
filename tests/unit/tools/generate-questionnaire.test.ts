import { describe, it, expect, vi } from 'vitest';
import { makeGenerateQuestionnaire } from '../../../src/features/questionnaire/application/tools/generate-questionnaire';
import type { QuestionnaireRepository } from '../../../src/features/questionnaire/domain/ports/questionnaire.repository';
import { QuestionnaireStatus, QuestionType } from '../../../src/shared/types';

describe('GenerateQuestionnaire Tool', () => {
  it('should create a published questionnaire when valid data is provided', async () => {
    const mockRepo: QuestionnaireRepository = {
      findById: vi.fn(),
      findAll: vi.fn(),
      update: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
    };

    const tool = makeGenerateQuestionnaire(mockRepo);
    const input = {
      title: 'Rapport d étonnement',
      description: 'Vos premières impressions',
      questions: [
        { id: 'q1', type: 'text', label: 'Comment trouvez-vous l intégration ?', required: true },
      ],
    };
    const result = (await tool.execute!(input as any, {} as any)) as any;

    expect(result).toBeDefined();
    expect(result.title).toBe(input.title);
    expect(result.status).toBe(QuestionnaireStatus.Published);
    expect(result.questionCount).toBe(1);
    expect(mockRepo.save).toHaveBeenCalled();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Le tool-result est une PROJECTION, jamais l'entité
  // ══════════════════════════════════════════════════════════════════════════
  // Quatrième occurrence du même défaut dans ce dépôt, après `getEmployeeProfile`
  // (2506 → 333), `generateDocument` (685 → 39) et `getNotificationHistory` (≈ 9600 → 177).
  it("ne renvoie jamais au modèle les questions qu'il vient d'écrire", async () => {
    const mockRepo: QuestionnaireRepository = {
      findById: vi.fn(),
      findAll: vi.fn(),
      update: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
    };

    const tool = makeGenerateQuestionnaire(mockRepo);
    const result = (await tool.execute!(
      {
        title: 'Rapport',
        questions: [
          { id: 'q1', type: 'text', label: 'A'.repeat(400), required: true },
          {
            id: 'q2',
            type: 'choice',
            label: 'B'.repeat(400),
            required: false,
            options: ['x'.repeat(180), 'y'.repeat(180)],
          },
        ],
      } as never,
      {} as never,
    )) as Record<string, unknown>;

    // L'auteur du texte est son destinataire : le lui refacturer n'apprend rien à personne,
    // et il resterait dans l'historique de toutes les étapes suivantes du run.
    expect(result.questions).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('AAAA');
    expect(JSON.stringify(result)).not.toContain('xxxx');

    // La propriété qui compte n'est pas le chiffre mais l'INDÉPENDANCE : la taille du
    // retour ne dépend ni du nombre de questions, ni de leur longueur.
    const court = (await tool.execute!(
      {
        title: 'Rapport',
        questions: [{ id: 'q1', type: 'text', label: 'A', required: true }],
      } as never,
      {} as never,
    )) as Record<string, unknown>;

    // Seuls `id` (un UUID de longueur fixe) et `questionCount` varient — jamais le contenu.
    expect(JSON.stringify(result).length - JSON.stringify(court).length).toBeLessThan(5);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // « Où est le quiz ? Je ne le vois pas » — relevé de production
  // ══════════════════════════════════════════════════════════════════════════
  // Un questionnaire enregistré n'est envoyé à personne, affiché nulle part, et remplissable
  // par personne : ni formulaire Block Kit, ni modale, ni route de soumission. Le modèle ne
  // pouvait pas le deviner, et son ignorance a pris trois formes en production :
  // « prêt à être utilisé », « je te le partage en lien direct ? », et « je peux te
  // partager un lien pour qu'il y accède ».
  it("dit que le questionnaire n'est ni envoyé, ni affiché, ni remplissable", async () => {
    const mockRepo: QuestionnaireRepository = {
      findById: vi.fn(),
      findAll: vi.fn(),
      update: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
    };

    const tool = makeGenerateQuestionnaire(mockRepo);
    const result = (await tool.execute!(
      {
        title: 'Quiz',
        questions: [{ id: 'q1', type: 'text', label: 'A', required: true }],
      } as never,
      {} as never,
    )) as Record<string, unknown>;

    // Même patron que `willBeSentAutomatically: false` sur `scheduleReminder` : le dépôt
    // corrige le MENSONGE, il ne construit pas le chemin manquant.
    expect(result.delivered).toBe(false);
    expect(String(result.hint)).toMatch(/lien/i);
  });

  it('emploie « enregistre » et jamais « crée » dans sa description', () => {
    // Le mot que lit le modèle est celui qu'il répétera — la leçon de `scheduleReminder`,
    // dont la description disait « planifie » alors qu'aucun automate ne reprend jamais le
    // statut `Scheduled`.
    const tool = makeGenerateQuestionnaire({
      findById: vi.fn(),
      findAll: vi.fn(),
      update: vi.fn(),
      save: vi.fn(),
    } as QuestionnaireRepository);

    expect(tool.description).toMatch(/enregistre/i);
    expect(tool.description).not.toMatch(/\bcrée\b|\bpublie\b/i);
  });
});

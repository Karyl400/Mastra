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
        { id: 'q1', type: 'text', label: 'Comment trouvez-vous l intégration ?', required: true }
      ]
    };
    const result = await tool.execute!(input as any, {} as any) as any;
    
    expect(result).toBeDefined();
    expect(result.title).toBe(input.title);
    expect(result.status).toBe(QuestionnaireStatus.Published);
    expect(result.questions).toHaveLength(1);
    expect(mockRepo.save).toHaveBeenCalled();
  });
});

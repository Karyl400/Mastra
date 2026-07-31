import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { QuestionnaireRepository } from '../../domain/ports/questionnaire.repository';
import { createQuestionnaire } from '../../domain/entities/questionnaire';
import { questionSchema } from '../../../../shared/validation';
import { logger } from '../../../../shared/logger';
import { QuestionnaireStatus } from '../../../../shared/types';

const generateQuestionnaireInputSchema = z.object({
  title: z.string().min(1).max(200).describe('Titre du questionnaire'),
  description: z.string().optional().describe('Description du questionnaire'),
  questions: z.array(questionSchema).min(1).describe('Questions du questionnaire'),
});

export function makeGenerateQuestionnaire(repo: QuestionnaireRepository) {
  return createTool({
    id: 'generateQuestionnaire',
    description: 'Crée un nouveau questionnaire avec ses questions',
    inputSchema: generateQuestionnaireInputSchema,
    execute: async (data, _ctx) => {
      logger.info('Création questionnaire', { title: data.title });
      const questionnaire = createQuestionnaire({
        id: crypto.randomUUID(),
        title: data.title,
        description: data.description ?? '',
        questions: data.questions.map((q: any) => ({ ...q, text: q.label })),
      });
      const published = { ...questionnaire, status: QuestionnaireStatus.Published, updatedAt: new Date().toISOString() };
      await repo.save(published);
      logger.info('Questionnaire créé', { id: published.id });
      return published;
    },
  });
}

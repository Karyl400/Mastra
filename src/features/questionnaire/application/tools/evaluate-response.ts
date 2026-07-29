import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { QuestionnaireRepository } from '../../domain/ports/questionnaire.repository';
import type { ResponseRepository } from '../../domain/ports/response.repository';
import { createResponse } from '../../domain/entities/questionnaire';
import { uuidSchema } from '../../../../shared/validation';
import { logger } from '../../../../shared/logger';
import { NotFoundError } from '../../../../shared/errors';
import { ResponseStatus } from '../../../../shared/types';

export function makeEvaluateResponse(
  questionnaireRepo: QuestionnaireRepository,
  responseRepo: ResponseRepository,
) {
  return createTool({
    id: 'evaluateResponse',
    description: 'Évalue les réponses d un employé à un questionnaire et calcule un score',
    inputSchema: z.object({
      questionnaireId: uuidSchema.describe('ID du questionnaire'),
      employeeId: uuidSchema.describe('ID de l employé'),
      answers: z.record(z.unknown()).describe('Réponses aux questions'),
    }),
    execute: async (data, _ctx) => {
      logger.info('Évaluation réponses', { questionnaireId: data.questionnaireId, employeeId: data.employeeId });

      const questionnaire = await questionnaireRepo.findById(data.questionnaireId);
      if (!questionnaire) throw new NotFoundError('Questionnaire', data.questionnaireId);

      const total = questionnaire.questions.length;
      const answered = Object.keys(data.answers).length;
      const score = total > 0 ? Math.round((answered / total) * 100) : 0;

      const response = createResponse({
        id: crypto.randomUUID(),
        questionnaireId: data.questionnaireId,
        employeeId: data.employeeId,
        answers: data.answers,
        score,
        submittedAt: new Date().toISOString(),
      });
      const evaluated = { ...response, status: ResponseStatus.Reviewed, updatedAt: new Date().toISOString() };
      await responseRepo.save(evaluated);

      return {
        responseId: evaluated.id,
        score,
        totalQuestions: total,
        answeredQuestions: answered,
        status: evaluated.status,
      };
    },
  });
}

import { Workflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { logger } from '../../../../shared/logger';

const questionnaireInputSchema = z.object({
  employeeId: z.string(),
  questionnaireId: z.string(),
});

const sendQuestionnaireStep = createStep({
  id: 'sendQuestionnaire',
  description: 'Envoie un questionnaire à un employé',
  inputSchema: questionnaireInputSchema,
  outputSchema: z.object({
    sentAt: z.string(),
    status: z.string(),
  }),
  execute: async ({ inputData }) => {
    logger.info('Exécution de sendQuestionnaireStep', { inputData });
    return { sentAt: new Date().toISOString(), status: 'SENT' };
  }
});

const collectResponsesStep = createStep({
  id: 'collectResponses',
  description: 'Collecte et enregistre les réponses de l\'employé',
  inputSchema: z.object({
    sentAt: z.string(),
    status: z.string(),
  }),
  outputSchema: z.object({
    collected: z.boolean(),
    responsesCount: z.number(),
  }),
  execute: async ({ inputData }) => {
    logger.info('Exécution de collectResponsesStep', { inputData });
    return { collected: true, responsesCount: 10 };
  }
});

export const questionnaireCycleWorkflow = new Workflow({
  id: 'questionnaire-cycle',
  description: 'Gère le cycle de vie complet d\'un questionnaire d\'intégration',
  inputSchema: questionnaireInputSchema,
  outputSchema: z.object({
    collected: z.boolean(),
    responsesCount: z.number(),
  }),
});

questionnaireCycleWorkflow
  .then(sendQuestionnaireStep)
  .then(collectResponsesStep)
  .commit();

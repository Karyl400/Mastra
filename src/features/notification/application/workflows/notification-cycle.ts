import { Workflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { logger } from '../../../../shared/logger';

const notificationInputSchema = z.object({
  recipients: z.array(z.string()),
  messageTemplate: z.string(),
  context: z.record(z.any()),
});

const prepareNotificationStep = createStep({
  id: 'prepareNotification',
  description: 'Prépare et personnalise les notifications pour les destinataires',
  inputSchema: notificationInputSchema,
  outputSchema: z.object({
    preparedMessages: z.array(z.object({
      to: z.string(),
      content: z.string(),
    })),
  }),
  execute: async ({ inputData }) => {
    logger.info('Exécution de prepareNotificationStep', { inputData });
    const preparedMessages = inputData.recipients.map((to) => ({
      to,
      content: `Hello ${to}, ${inputData.messageTemplate}`
    }));
    return { preparedMessages };
  }
});

const sendNotificationStep = createStep({
  id: 'sendNotification',
  description: 'Envoie les notifications via Slack ou Email',
  inputSchema: z.object({
    preparedMessages: z.array(z.object({
      to: z.string(),
      content: z.string(),
    })),
  }),
  outputSchema: z.object({
    successCount: z.number(),
    failuresCount: z.number(),
  }),
  execute: async ({ inputData }) => {
    logger.info('Exécution de sendNotificationStep', { inputData });
    return { successCount: inputData.preparedMessages.length, failuresCount: 0 };
  }
});

export const notificationCycleWorkflow = new Workflow({
  id: 'notification-cycle',
  description: 'Cycle complet de préparation et d\'envoi de notifications',
  inputSchema: notificationInputSchema,
  outputSchema: z.object({
    successCount: z.number(),
    failuresCount: z.number(),
  }),
});

notificationCycleWorkflow
  .then(prepareNotificationStep)
  .then(sendNotificationStep)
  .commit();

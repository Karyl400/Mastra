import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { NotificationRepository } from '../../domain/ports/notification.repository';
import { uuidSchema } from '../../../../shared/validation';
import { logger } from '../../../../shared/logger';

export function makeGetNotificationHistory(repo: NotificationRepository) {
  return createTool({
    id: 'getNotificationHistory',
    description: 'Récupère l historique des notifications d un destinataire',
    inputSchema: z.object({
      recipientId: uuidSchema.describe('ID du destinataire'),
      limit: z.number().int().min(1).max(100).optional().default(50).describe('Nombre maximum de notifications'),
    }),
    execute: async (data, _ctx) => {
      logger.info('Récupération historique notifications', { recipientId: data.recipientId });
      const all = await repo.findByRecipient(data.recipientId);
      const notifications = all.slice(-data.limit).reverse();
      return { notifications, total: all.length };
    },
  });
}

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { NotificationRepository } from '../../domain/ports/notification.repository';
import { createNotification } from '../../domain/entities/notification';
import { uuidSchema } from '../../../../shared/validation';
import { logger } from '../../../../shared/logger';
import { NotificationChannel, NotificationStatus, RecipientType } from '../../../../shared/types';

export function makeScheduleReminder(repo: NotificationRepository) {
  return createTool({
    id: 'scheduleReminder',
    description: 'Planifie un rappel pour un employé ou un manager',
    inputSchema: z.object({
      recipientId: uuidSchema.describe('ID du destinataire'),
      recipientType: z.nativeEnum(RecipientType).describe('Type de destinataire'),
      channel: z.nativeEnum(NotificationChannel).describe('Canal de notification'),
      subject: z.string().min(1).max(200).describe('Sujet du rappel'),
      body: z.string().min(1).describe('Corps du rappel'),
      scheduledAt: z.string().datetime().describe('Date d envoi planifiée au format ISO'),
    }),
    execute: async (data, _ctx) => {
      logger.info('Planification rappel', { recipientId: data.recipientId, scheduledAt: data.scheduledAt });
      const notif = createNotification({
        id: crypto.randomUUID(),
        recipientId: data.recipientId,
        recipientType: data.recipientType,
        channel: data.channel,
        subject: data.subject,
        body: data.body,
      });
      const scheduled = { ...notif, status: NotificationStatus.Scheduled, scheduledAt: data.scheduledAt, updatedAt: new Date().toISOString() };
      await repo.save(scheduled);
      return scheduled;
    },
  });
}

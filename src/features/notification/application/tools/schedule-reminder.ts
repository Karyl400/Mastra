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
    // Schéma volontairement dépouillé : chaque caractère de ce JSON Schema est
    // réémis au modèle à CHAQUE aller-retour (plafond Groq 12 000 tok/min), et
    // le schéma pesait 232 tokens à lui seul. Les `.describe()` retirés ne
    // faisaient que répéter le nom du champ (« Sujet du rappel » sur `subject`) ;
    // seuls survivent les deux qui portent une information que ni le nom ni le
    // type ne donnent. Aucun champ ni aucune règle de validation n'a bougé.
    inputSchema: z.object({
      recipientId: uuidSchema.describe('UUID annuaire'),
      recipientType: z.nativeEnum(RecipientType),
      channel: z.nativeEnum(NotificationChannel),
      subject: z.string().min(1).max(200),
      body: z.string().min(1),
      scheduledAt: z.string().datetime().describe('ISO 8601'),
    }),
    execute: async (data, _ctx) => {
      logger.info('Planification rappel', {
        recipientId: data.recipientId,
        scheduledAt: data.scheduledAt,
      });
      const notif = createNotification({
        id: crypto.randomUUID(),
        recipientId: data.recipientId,
        recipientType: data.recipientType,
        channel: data.channel,
        subject: data.subject,
        body: data.body,
      });
      const scheduled = {
        ...notif,
        status: NotificationStatus.Scheduled,
        scheduledAt: data.scheduledAt,
        updatedAt: new Date().toISOString(),
      };
      await repo.save(scheduled);
      return scheduled;
    },
  });
}

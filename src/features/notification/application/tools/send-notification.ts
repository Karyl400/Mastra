import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { NotificationRepository } from '../../domain/ports/notification.repository';
import type { EmailProvider, ChatProvider } from '../../domain/ports/providers';
import { createNotification } from '../../domain/entities/notification';
import { uuidSchema } from '../../../../shared/validation';
import { logger } from '../../../../shared/logger';
import { NotificationChannel, NotificationStatus, RecipientType } from '../../../../shared/types';
import { ValidationError } from '../../../../shared/errors';

export function makeSendNotification(
  repo: NotificationRepository,
  emailProvider: EmailProvider,
  chatProvider: ChatProvider
) {
  return createTool({
    id: 'sendNotification',
    description: 'Envoie une notification à un employé ou un manager (email, Slack, in-app)',
    inputSchema: z.object({
      recipientId: uuidSchema.describe('ID du destinataire'),
      recipientEmail: z.string().email().optional().describe('Email du destinataire (requis si channel=email)'),
      recipientSlackId: z.string().optional().describe('Slack ID (requis si channel=slack)'),
      recipientType: z.nativeEnum(RecipientType).describe('Type de destinataire'),
      channel: z.nativeEnum(NotificationChannel).describe('Canal de notification'),
      subject: z.string().min(1).max(200).describe('Sujet de la notification'),
      body: z.string().min(1).describe('Corps de la notification'),
    }),
    execute: async (data, _ctx) => {
      logger.info('Envoi notification', { recipientId: data.recipientId, channel: data.channel, subject: data.subject });
      
      let status = NotificationStatus.Sent;

      try {
        if (data.channel === NotificationChannel.Email) {
          if (!data.recipientEmail) 
              throw new ValidationError('Email requis pour NotificationChannel.Email');
          await emailProvider.sendEmail(data.recipientEmail, data.subject, data.body);
        } else if (data.channel === NotificationChannel.Slack) {
          if (!data.recipientSlackId) 
              throw new ValidationError('Slack ID requis pour NotificationChannel.Slack');
          await chatProvider.sendMessage(data.recipientSlackId, `*${data.subject}*\n\n${data.body}`);
        }
        // InApp est juste sauvegardé en BD
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Erreur inconnue';
        logger.error('Erreur lors de l envoi de la notification', { error: message });
        status = NotificationStatus.Failed;
      }

      const notif = createNotification({
        id: crypto.randomUUID(),
        recipientId: data.recipientId,
        recipientType: data.recipientType,
        channel: data.channel,
        subject: data.subject,
        body: data.body,
      });

      const sent = { 
        ...notif, 
        status, 
        sentAt: status === NotificationStatus.Sent ? new Date().toISOString() : null, 
        updatedAt: new Date().toISOString() 
      };
      
      await repo.save(sent);
      logger.info('Notification enregistrée', { id: sent.id, status });
      return sent;
    },
  });
}

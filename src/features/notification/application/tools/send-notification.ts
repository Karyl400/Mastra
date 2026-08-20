import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { NotificationRepository } from '../../domain/ports/notification.repository';
import type { EmployeeRepository } from '../../domain/ports/employee.repository';
import type { EmailProvider, ChatProvider } from '../../domain/ports/providers';
import { textEmailBody } from '../../domain/services/email-body';
import {
  sanitizeNotificationBody,
  type SanitizedDocumentText,
} from '../../../../shared/security/agent-output';
import type { SlackWorkspaceProvider } from '../../domain/ports/slack-workspace.port';
import { createNotification } from '../../domain/entities/notification';
import { uuidSchema } from '../../../../shared/validation';
import { logger } from '../../../../shared/logger';
import { NotificationChannel, NotificationStatus, RecipientType } from '../../../../shared/types';
import { NotFoundError } from '../../../../shared/errors';
import { canPerformSideEffects } from '../../../../shared/slack-request-context';

const TRANSPORTED_CHANNELS = ['email', 'slack'] as const;

const RECIPIENT_TYPES = ['employee', 'manager', 'hr', 'admin'] as const;

function safeNotificationBody(
  raw: string,
  context: { recipientId: string; channel: string },
): SanitizedDocumentText {
  const safe = sanitizeNotificationBody(raw);

  if (safe.redacted.length > 0 || safe.strippedUrls.length > 0) {
    logger.error('Notification assainie avant envoi', {
      ...context,
      redacted: safe.redacted,
      strippedUrls: safe.strippedUrls,
    });
  }

  return safe;
}

export function makeSendNotification(
  repo: NotificationRepository,
  employeeRepo: EmployeeRepository,
  emailProvider: EmailProvider,
  chatProvider: ChatProvider,
  slackWorkspace: SlackWorkspaceProvider,
) {
  return createTool({
    id: 'sendNotification',
    description:
      'Envoie un message à un employé enregistré, désigné par son recipientId — ' +
      'jamais par une adresse.',
    inputSchema: z.object({
      recipientId: uuidSchema.describe('UUID annuaire ; adresse résolue côté serveur.'),
      subject: z.string().min(1).max(200).describe('rédige-le, ne le demande pas'),
      body: z.string().min(1).max(5000).describe('rédige-le, ne le demande pas'),
      channel: z.enum(TRANSPORTED_CHANNELS).default('email'),
      recipientType: z.enum(RECIPIENT_TYPES).default('employee'),
    }),
    execute: async (data, _ctx) => {
      if (!canPerformSideEffects(_ctx?.requestContext, data.recipientId)) {
        logger.warn('sendNotification refusé : le demandeur n’a pas le niveau requis', {
          recipientId: data.recipientId,
        });
        return {
          sent: false,
          reason: 'not_authorized',
          hint: 'Tu ne peux agir que sur ton propre dossier — celui de quelqu’un d’autre est réservé au manager. Dis-le simplement, ne réessaie pas.',
        };
      }

      const channel = data.channel ?? 'email';
      const recipientType = (data.recipientType ?? 'employee') as RecipientType;

      logger.info('Envoi notification', {
        recipientId: data.recipientId,
        recipientType,
        channel,
        subject: data.subject,
      });

      const supplied = data as Record<string, unknown>;
      if (supplied.recipientEmail !== undefined || supplied.recipientSlackId !== undefined) {
        logger.warn(
          'Destination fournie par le modèle ignorée — la résolution se fait depuis la base',
          { recipientId: data.recipientId, channel },
        );
      }

      const recipient = await employeeRepo.findById(data.recipientId);
      if (!recipient) {
        logger.error("Destinataire introuvable dans l'annuaire — envoi refusé", {
          recipientId: data.recipientId,
          recipientType,
          channel,
        });
        throw new NotFoundError('Destinataire introuvable', data.recipientId);
      }

      let destination: string;

      if (channel === 'email') {
        if (!recipient.email) {
          throw new NotFoundError("Adresse email absente de l'annuaire", data.recipientId);
        }
        destination = recipient.email;
      } else {
        const member = await slackWorkspace.findUserByEmail(recipient.email);
        if (!member?.id) {
          logger.error('Compte Slack introuvable pour le destinataire — envoi refusé', {
            recipientId: data.recipientId,
          });
          throw new NotFoundError('Compte Slack du destinataire introuvable', data.recipientId);
        }
        destination = member.id;
      }

      let status: NotificationStatus;

      const safe = safeNotificationBody(data.body, { recipientId: data.recipientId, channel });

      try {
        if (channel === 'email') {
          await emailProvider.sendEmail(destination, data.subject, textEmailBody(safe.text));
        } else {
          await chatProvider.sendMessage(destination, `*${data.subject}*\n\n${safe.text}`);
        }
        status = NotificationStatus.Sent;
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Erreur inconnue';
        logger.error("Erreur lors de l'envoi de la notification", {
          error: message,
          recipientId: data.recipientId,
          channel,
        });
        status = NotificationStatus.Failed;
      }

      const notif = createNotification({
        id: crypto.randomUUID(),
        recipientId: data.recipientId,
        recipientType,
        channel: channel as NotificationChannel,
        subject: data.subject,
        body: safe.text,
      });

      const sent = {
        ...notif,
        status,
        sentAt: status === NotificationStatus.Sent ? new Date().toISOString() : null,
        updatedAt: new Date().toISOString(),
      };

      await repo.save(sent);
      logger.info('Notification enregistrée', { id: sent.id, status });

      return {
        id: sent.id,
        recipientId: sent.recipientId,
        channel: sent.channel,
        status: sent.status,
        sentAt: sent.sentAt,
      };
    },
  });
}

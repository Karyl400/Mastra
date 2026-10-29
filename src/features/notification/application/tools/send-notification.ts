import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { NotificationRepository } from '../../domain/ports/notification.repository';
import type { EmployeeRepository } from '../../domain/ports/employee.repository';
import type { EmailProvider, ChatProvider } from '../../domain/ports/providers';
import { textEmailBody } from '../../domain/services/email-body';
import { safeOutboundText } from '../services/outbound-text';
import type { SlackWorkspaceProvider } from '../../domain/ports/slack-workspace.port';
import { createNotification } from '../../domain/entities/notification';
import { uuidSchema } from '../../../../shared/validation';
import { logger } from '../../../../shared/logger';
import { NotificationChannel, NotificationStatus, RecipientType } from '../../../../shared/types';
import { NotFoundError, errorMessage } from '../../../../shared/errors';
import {
  canPerformSideEffects,
  noRequesterRefusal,
  readSlackContext,
} from '../../../../shared/slack-request-context';
import { buildRunKey, makeRunGuard, textFingerprint } from '../../../../shared/tool-idempotency';

const TRANSPORTED_CHANNELS = ['email', 'slack'] as const;

const RECIPIENT_TYPES = ['employee', 'manager', 'hr', 'admin'] as const;

function sendRunKey(
  requestContext: unknown,
  data: { recipientId: string; subject: string; body: string },
  channel: string,
): string | undefined {
  return buildRunKey(readSlackContext(requestContext as never)?.eventTs, 'sendNotification', [
    data.recipientId,
    channel,
    textFingerprint(`${data.subject}\u0000${data.body}`),
  ]);
}

async function resolveDestination(
  slackWorkspace: SlackWorkspaceProvider,
  target: { recipientId: string; email: string; channel: string },
): Promise<string> {
  if (target.channel === 'email') {
    if (!target.email) {
      throw new NotFoundError("Adresse email absente de l'annuaire", target.recipientId);
    }
    return target.email;
  }

  const member = await slackWorkspace.findUserByEmail(target.email);
  if (!member?.id) {
    logger.error('Compte Slack introuvable pour le destinataire — envoi refusé', {
      recipientId: target.recipientId,
    });
    throw new NotFoundError('Compte Slack du destinataire introuvable', target.recipientId);
  }
  return member.id;
}

function warnIfDestinationSupplied(data: { recipientId: string }, channel: string): void {
  const supplied = data as Record<string, unknown>;
  if (supplied.recipientEmail !== undefined || supplied.recipientSlackId !== undefined) {
    logger.warn(
      'Destination fournie par le modèle ignorée — la résolution se fait depuis la base',
      { recipientId: data.recipientId, channel },
    );
  }
}

async function deliver(
  providers: { emailProvider: EmailProvider; chatProvider: ChatProvider },
  route: { channel: string; destination: string },
  safe: { subject: string; body: string },
  recipientId: string,
): Promise<NotificationStatus> {
  try {
    if (route.channel === 'email') {
      await providers.emailProvider.sendEmail(
        route.destination,
        safe.subject,
        textEmailBody(safe.body),
      );
    } else {
      await providers.chatProvider.sendMessage(
        route.destination,
        `*${safe.subject}*\n\n${safe.body}`,
      );
    }
    return NotificationStatus.Sent;
  } catch (e: unknown) {
    logger.error("Erreur lors de l'envoi de la notification", {
      error: errorMessage(e),
      recipientId,
      channel: route.channel,
    });
    return NotificationStatus.Failed;
  }
}

function buildSentNotification(
  recipientId: string,
  recipientType: RecipientType,
  channel: string,
  safe: { subject: string; body: string },
  status: NotificationStatus,
) {
  const notif = createNotification({
    id: crypto.randomUUID(),
    recipientId,
    recipientType,
    channel: channel as NotificationChannel,
    subject: safe.subject,
    body: safe.body,
  });

  return {
    ...notif,
    status,
    sentAt: status === NotificationStatus.Sent ? new Date().toISOString() : null,
    updatedAt: new Date().toISOString(),
  };
}

async function requireRecipient(
  employeeRepo: EmployeeRepository,
  recipientId: string,
  recipientType: RecipientType,
  channel: string,
) {
  const recipient = await employeeRepo.findById(recipientId);
  if (!recipient) {
    logger.error("Destinataire introuvable dans l'annuaire — envoi refusé", {
      recipientId,
      recipientType,
      channel,
    });
    throw new NotFoundError('Destinataire introuvable', recipientId);
  }
  return recipient;
}

const sendNotificationInput = z.object({
  recipientId: uuidSchema.describe('UUID annuaire ; adresse résolue côté serveur.'),
  subject: z.string().min(1).max(200).describe('rédige-le, ne le demande pas'),
  body: z.string().min(1).max(5000).describe('rédige-le, ne le demande pas'),
  channel: z.enum(TRANSPORTED_CHANNELS).default('email'),
  recipientType: z.enum(RECIPIENT_TYPES).default('employee'),
});

function refuseIfNotAllowed(requestContext: unknown, recipientId: string) {
  if (canPerformSideEffects(requestContext, recipientId)) {
    return null;
  }
  logger.warn('sendNotification refusé : le demandeur n’a pas le niveau requis', { recipientId });
  return {
    sent: false,
    reason: 'not_authorized',
    hint: 'Tu ne peux agir que sur ton propre dossier — celui de quelqu’un d’autre est réservé au manager. Dis-le simplement, ne réessaie pas.',
  };
}

export function makeSendNotification(
  repo: NotificationRepository,
  employeeRepo: EmployeeRepository,
  emailProvider: EmailProvider,
  chatProvider: ChatProvider,
  slackWorkspace: SlackWorkspaceProvider,
) {
  const runGuard = makeRunGuard();

  return createTool({
    id: 'sendNotification',
    description:
      'Envoie un message à un employé enregistré, désigné par son recipientId — ' +
      'jamais par une adresse.',
    inputSchema: sendNotificationInput,
    execute: async (data, _ctx) => {
      const refused = noRequesterRefusal(_ctx?.requestContext, 'sendNotification', {
        sent: false as const,
      });
      if (refused) {
        return refused;
      }
      const notAuthorized = refuseIfNotAllowed(_ctx?.requestContext, data.recipientId);
      if (notAuthorized) {
        return notAuthorized;
      }

      const channel = data.channel ?? 'email';
      const recipientType = (data.recipientType ?? 'employee') as RecipientType;

      const runKey = sendRunKey(_ctx?.requestContext, data, channel);
      const already = runKey ? runGuard.get<Record<string, unknown>>(runKey) : undefined;
      if (already) {
        logger.warn('Notification déjà envoyée dans ce run — second appel ignoré', {
          recipientId: data.recipientId,
          channel,
        });
        return already;
      }

      logger.info('Envoi notification', {
        recipientId: data.recipientId,
        recipientType,
        channel,
        subject: data.subject,
      });

      warnIfDestinationSupplied(data, channel);

      const recipient = await requireRecipient(
        employeeRepo,
        data.recipientId,
        recipientType,
        channel,
      );

      const destination = await resolveDestination(slackWorkspace, {
        recipientId: data.recipientId,
        email: recipient.email,
        channel,
      });

      const safe = safeOutboundText(
        { subject: data.subject, body: data.body },
        { recipientId: data.recipientId, channel, tool: 'sendNotification' },
      );

      const status = await deliver(
        { emailProvider, chatProvider },
        { channel, destination },
        safe,
        data.recipientId,
      );
      const sent = buildSentNotification(data.recipientId, recipientType, channel, safe, status);

      await repo.save(sent);
      logger.info('Notification enregistrée', { id: sent.id, status });

      const result = {
        id: sent.id,
        recipientId: sent.recipientId,
        channel: sent.channel,
        status: sent.status,
        sentAt: sent.sentAt,
      };

      if (runKey && status === NotificationStatus.Sent) {
        runGuard.remember(runKey, result);
      }

      return result;
    },
  });
}

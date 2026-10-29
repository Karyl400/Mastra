import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { NotificationRepository } from '../../domain/ports/notification.repository';
import type { Notification } from '../../domain/entities/notification';
import { uuidSchema, emailSchema } from '../../../../shared/validation';
import { logger } from '../../../../shared/logger';
import {
  canReadPersonRecord,
  hasIdentifiedRequester,
  NO_REQUESTER_HINT,
} from '../../../../shared/slack-request-context';
import { NotificationStatus, type NotificationChannel } from '../../../../shared/types';
import { isDispatchableStatus } from '../../domain/services/reminder-dispatch';

const NOT_AUTHORIZED_HINT =
  "Tu n'as pas accès aux messages reçus par cette personne. Dis-le simplement, sans détour " +
  'et sans inventer de motif. Ne réessaie pas avec un autre outil et ne reformule pas la ' +
  'demande.';

export const MAX_NOTIFICATIONS_IN_RESULT = 5;

const SUBJECT_MAX_CHARS = 80;

export interface NotificationSummary {
  readonly channel: NotificationChannel;
  readonly status: string;
  readonly subject: string;
  readonly at: string;
}

export interface NotificationHistoryPage {
  readonly notifications: NotificationSummary[];
  readonly total: number;
  readonly shown: number;
}

function dateOf(n: Notification): string {
  return n.sentAt ?? n.scheduledAt ?? n.createdAt;
}

function honestStatus(status: NotificationStatus): string {
  if (isDispatchableStatus(status)) {
    return 'enregistré, remise automatique le matin du jour prévu';
  }
  if (status === NotificationStatus.Sending) {
    return 'remise en cours';
  }
  return status;
}

function toSummary(n: Notification): NotificationSummary {
  const subject =
    n.subject.length > SUBJECT_MAX_CHARS
      ? `${n.subject.slice(0, SUBJECT_MAX_CHARS)}...`
      : n.subject;
  return { channel: n.channel, status: honestStatus(n.status), subject, at: dateOf(n) };
}

function emptyHistory<R extends string>(refusal: { reason: R; hint: string }) {
  return { notifications: [], total: 0, shown: 0, ...refusal };
}

export function makeGetNotificationHistory(
  repo: NotificationRepository,
  employeeRepo?: { findByEmail(email: string): Promise<{ id: string } | null> },
) {
  return createTool({
    id: 'getNotificationHistory',
    description: 'Les 5 derniers messages envoyés à un destinataire (sans leur contenu).',
    inputSchema: z.object({
      recipientId: uuidSchema.optional(),
      email: emailSchema.optional().describe('Email pro — alternative à recipientId'),
    }),
    execute: async (data, _ctx) => {
      if (!hasIdentifiedRequester(_ctx?.requestContext)) {
        logger.warn('Historique de notifications refusé — aucun demandeur identifié');
        return {
          notifications: [],
          total: 0,
          shown: 0,
          found: false as const,
          reason: 'no_requester' as const,
          hint: NO_REQUESTER_HINT,
        };
      }

      const email = data.email ? String(data.email).trim().toLowerCase() : undefined;

      if (!data.recipientId && !email) {
        return emptyHistory({
          reason: 'missing_identifier',
          hint: "Précise QUI : l'email ou l'identifiant du destinataire.",
        });
      }

      let recipientId = data.recipientId;

      if (!recipientId && email) {
        if (!employeeRepo) {
          return emptyHistory({
            reason: 'missing_identifier',
            hint: "Donne l'identifiant du destinataire : la recherche par email n'est pas disponible ici.",
          });
        }

        const resolved = await employeeRepo.findByEmail(email);

        if (!canReadPersonRecord(_ctx?.requestContext, resolved?.id ?? null)) {
          logger.warn('Lecture d’historique refusée — demandeur non autorisé (par email)');
          return emptyHistory({ reason: 'not_authorized', hint: NOT_AUTHORIZED_HINT });
        }

        if (!resolved) {
          return emptyHistory({
            reason: 'recipient_not_found',
            hint: "Aucun employé ne porte cette adresse. Ne l'invente pas : demande-la.",
          });
        }

        recipientId = resolved.id;
      }

      if (!canReadPersonRecord(_ctx?.requestContext, recipientId)) {
        logger.warn('Lecture d’historique refusée — demandeur non autorisé', {
          recipientId,
        });
        return emptyHistory({ reason: 'not_authorized', hint: NOT_AUTHORIZED_HINT });
      }

      logger.info('Récupération historique notifications', { recipientId });
      const all = await repo.findByRecipient(recipientId as string);

      const sorted = [...all].sort((a, b) => {
        const byDate = dateOf(b).localeCompare(dateOf(a));
        return byDate !== 0 ? byDate : b.id.localeCompare(a.id);
      });

      const notifications = sorted.slice(0, MAX_NOTIFICATIONS_IN_RESULT).map(toSummary);
      return { notifications, total: all.length, shown: notifications.length };
    },
  });
}

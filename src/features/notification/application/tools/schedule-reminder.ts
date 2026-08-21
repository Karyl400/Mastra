import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { NotificationRepository } from '../../domain/ports/notification.repository';
import type { EmployeeRepository } from '../../domain/ports/employee.repository';
import { createNotification } from '../../domain/entities/notification';
import { uuidSchema } from '../../../../shared/validation';
import { logger } from '../../../../shared/logger';
import { NotificationChannel, NotificationStatus, RecipientType } from '../../../../shared/types';
import { NotFoundError, ValidationError } from '../../../../shared/errors';
import {
  canPerformSideEffects,
  writeReminderDelivery,
} from '../../../../shared/slack-request-context';
import { safeOutboundText } from '../services/outbound-text';
import { deliveryLabel } from '../../domain/services/reminder-dispatch';

const TRANSPORTED_CHANNELS = ['email', 'slack'] as const;
const RECIPIENT_TYPES = ['employee', 'manager', 'hr', 'admin'] as const;

export function makeScheduleReminder(
  repo: NotificationRepository,
  employeeRepo?: EmployeeRepository,
) {
  return createTool({
    id: 'scheduleReminder',
    description:
      'Enregistre un rappel daté. Il est remis automatiquement le matin du jour demandé.',
    inputSchema: z.object({
      recipientId: uuidSchema.describe('UUID annuaire'),
      subject: z.string().min(1).max(200).describe('rédige-le, ne le demande pas'),
      body: z.string().min(1).max(5000).describe('rédige-le, ne le demande pas'),
      scheduledAt: z.string().describe('ISO 8601, dans le futur'),
      channel: z.enum(TRANSPORTED_CHANNELS).default('email'),
      recipientType: z.enum(RECIPIENT_TYPES).default('employee'),
    }),
    execute: async (data, _ctx) => {
      if (!canPerformSideEffects(_ctx?.requestContext, data.recipientId)) {
        logger.warn('scheduleReminder refusé : le demandeur n’a pas le niveau requis', {
          recipientId: data.recipientId,
        });
        return {
          stored: false as const,
          reason: 'not_authorized' as const,
          hint: 'Tu ne peux agir que sur ton propre dossier — celui de quelqu’un d’autre est réservé au manager. Dis-le simplement, ne réessaie pas.',
        };
      }

      const channel = data.channel ?? 'email';
      const recipientType = (data.recipientType ?? 'employee') as RecipientType;

      logger.info('Enregistrement rappel', {
        recipientId: data.recipientId,
        scheduledAt: data.scheduledAt,
      });

      const when = Date.parse(data.scheduledAt);
      if (Number.isNaN(when)) {
        throw new ValidationError(
          `Date de rappel illisible (ISO 8601 attendu, dans le futur) : ${data.scheduledAt}`,
        );
      }
      if (when <= Date.now()) {
        throw new ValidationError(
          `Date de rappel déjà passée — elle doit être dans le futur : ${data.scheduledAt}`,
        );
      }

      if (employeeRepo) {
        const recipient = await employeeRepo.findById(data.recipientId);
        if (!recipient) {
          logger.error("Destinataire du rappel introuvable dans l'annuaire — refusé", {
            recipientId: data.recipientId,
          });
          throw new NotFoundError('Destinataire introuvable', data.recipientId);
        }
      } else {
        logger.warn(
          "Annuaire non câblé : rappel enregistré sans vérifier l'existence du destinataire",
          { recipientId: data.recipientId },
        );
      }

      /**
       * ⚠️ **ON ASSAINIT À L'ÉCRITURE, ET PAS SEULEMENT À LA REMISE.**
       *
       * Deux raisons, et la seconde est celle qu'on oublie :
       *  1. le cron du 2026-08-21 expédie ce texte le lendemain matin, sans qu'aucun humain
       *     ne le relise — c'est le seul chemin sortant du produit dans ce cas ;
       *  2. la ligne est RELUE par `getNotificationHistory`, qui la rend au modèle. Un
       *     marqueur interne stocké ici ressortirait tel quel au premier tour suivant.
       *
       * Le défaut dormait tant que rien ne partait. Allumer l'ordonnanceur l'a réveillé —
       * même mécanique que `onlyNonDeliveringTools` le même jour : **un assainisseur, comme
       * un détecteur, encode le câblage ; quand le câblage bouge, il faut le déplacer avec.**
       */
      const safe = safeOutboundText(
        { subject: data.subject, body: data.body },
        { recipientId: data.recipientId, channel, tool: 'scheduleReminder' },
      );

      const notif = createNotification({
        id: crypto.randomUUID(),
        recipientId: data.recipientId,
        recipientType,
        channel: channel as NotificationChannel,
        subject: safe.subject,
        body: safe.body,
      });
      const scheduled = {
        ...notif,
        status: NotificationStatus.Scheduled,
        scheduledAt: data.scheduledAt,
        updatedAt: new Date().toISOString(),
      };
      await repo.save(scheduled);
      logger.info('Rappel enregistré', { id: scheduled.id, scheduledAt: scheduled.scheduledAt });

      /**
       * ⚠️ **ON REND LE MOMENT DE REMISE, PAS LE MOMENT DEMANDÉ.**
       *
       * Ce tool rendait `scheduledLabel: 'lundi 24 août 2026 à 09 h00'` — l'heure que la
       * personne avait dite. Le cron ne passe qu'UNE FOIS PAR JOUR (limite du plan Hobby,
       * ±59 min de précision) : annoncer une heure serait promettre ce qu'aucune pièce de ce
       * système ne tient. Le modèle ne peut pas répéter une précision qu'on ne lui donne pas.
       *
       * `willBeSentAutomatically` passe à `true`, et c'est enfin vrai — voir
       * `reminder-dispatch.ts` et `/internal/reminders/dispatch`.
       */
      const delivery = deliveryLabel(scheduled.scheduledAt, new Date());
      if (delivery) writeReminderDelivery(_ctx?.requestContext, delivery);

      return {
        id: scheduled.id,
        recipientId: scheduled.recipientId,
        channel: scheduled.channel,
        deliveredOn: delivery,
        stored: true,
        willBeSentAutomatically: true,
      };
    },
  });
}

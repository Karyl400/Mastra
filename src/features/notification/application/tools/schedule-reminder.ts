/**
 * Rappel daté — outil exposé au LLM.
 *
 * ## Ce que cet outil NE FAIT PAS, et pourquoi il le dit
 *
 * Le statut `Scheduled` qu'il pose n'est lu **nulle part** : il n'existe ni cron ni
 * poller dans ce dépôt, et `findPending()` — le seul lecteur imaginable — n'a aucun
 * site d'appel et filtre de toute façon sur `Pending`. Aucun rappel enregistré ici
 * n'a jamais été expédié, et aucun ne le sera tant que l'ordonnanceur n'existe pas.
 *
 * Décision assumée : **on ne construit pas l'ordonnanceur** (chantier d'infrastructure,
 * hors de ce lot). Ce qui est corrigé, c'est le MENSONGE — un agent qui lisait
 * « planifié » promettait un envoi qui n'aurait jamais lieu. La description et le
 * tool-result disent maintenant « enregistré », et le verdict porte explicitement
 * `willBeSentAutomatically: false`. Un mensonge silencieux est pire qu'une panne
 * bruyante ; ici, il n'y a même pas de panne — seulement un mémo.
 *
 * ## Deux refus bruyants, alignés sur `sendNotification`
 *
 * 1. **Destinataire inconnu** → `NotFoundError`. `sendNotification` résout son
 *    destinataire depuis l'annuaire ; ne pas le faire ici laissait enregistrer des
 *    rappels pour des UUID qui ne désignent personne — invisibles jusqu'au jour où
 *    quelqu'un lirait la table.
 * 2. **Date passée** → `ValidationError`. « Rappelle-lui hier » n'a aucun sens et le
 *    modèle produisait volontiers une date d'aujourd'hui déjà écoulée.
 *
 * La date est validée dans `execute` et non par `z.string().datetime()` : la validation
 * de schéma de Mastra RETOURNE un objet d'erreur au lieu de lever, et il n'y a aucune
 * raison que « format illisible » et « date passée » suivent deux régimes d'erreur
 * différents. Effet de bord bienvenu : le mot-clé `format` sort du JSON Schema.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { NotificationRepository } from '../../domain/ports/notification.repository';
import type { EmployeeRepository } from '../../domain/ports/employee.repository';
import { createNotification } from '../../domain/entities/notification';
import { uuidSchema } from '../../../../shared/validation';
import { logger } from '../../../../shared/logger';
import { NotificationChannel, NotificationStatus, RecipientType } from '../../../../shared/types';
import { NotFoundError, ValidationError } from '../../../../shared/errors';

/** Mêmes canaux que `sendNotification` : ce sont les seuls qu'on saurait acheminer. */
const TRANSPORTED_CHANNELS = ['email', 'slack'] as const;
const RECIPIENT_TYPES = ['employee', 'manager', 'hr', 'admin'] as const;

/**
 * @param employeeRepo Annuaire, pour refuser un destinataire inexistant. Optionnel
 *   uniquement parce que `src/mastra/index.ts` ne le câble pas encore (le fichier
 *   appartient à un autre lot) : sans lui, le rappel est enregistré sans vérification
 *   du destinataire — et c'est le seul cas où ce tool est moins strict que
 *   `sendNotification`.
 */
export function makeScheduleReminder(
  repo: NotificationRepository,
  employeeRepo?: EmployeeRepository,
) {
  return createTool({
    id: 'scheduleReminder',
    // « enregistre », jamais « planifie » : le mot que lit le modèle est celui qu'il
    // répétera à l'utilisateur.
    description: 'Enregistre un rappel daté. Aucun automate ne le reprend : rien ne part seul.',
    inputSchema: z.object({
      recipientId: uuidSchema.describe('UUID annuaire'),
      subject: z.string().min(1).max(200).describe('rédige-le, ne le demande pas'),
      body: z.string().min(1).describe('rédige-le, ne le demande pas'),
      scheduledAt: z.string().describe('ISO 8601, dans le futur'),
      channel: z.enum(TRANSPORTED_CHANNELS).default('email'),
      recipientType: z.enum(RECIPIENT_TYPES).default('employee'),
    }),
    execute: async (data, _ctx) => {
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

      const notif = createNotification({
        id: crypto.randomUUID(),
        recipientId: data.recipientId,
        recipientType,
        channel: channel as NotificationChannel,
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
      logger.info('Rappel enregistré', { id: scheduled.id, scheduledAt: scheduled.scheduledAt });

      // Verdict PROJETÉ et sans ambiguïté. Ni `subject` ni `body` : le modèle vient de
      // les écrire, les lui renvoyer serait payé à chaque tour suivant. Les deux
      // booléens sont là pour qu'aucune formulation de la réponse ne puisse promettre
      // un envoi.
      return {
        id: scheduled.id,
        recipientId: scheduled.recipientId,
        channel: scheduled.channel,
        scheduledAt: scheduled.scheduledAt,
        stored: true,
        willBeSentAutomatically: false,
      };
    },
  });
}

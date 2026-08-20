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
import { canPerformSideEffects } from '../../../../shared/slack-request-context';
import { DISPLAY_TIMEZONE, frenchFullLabel } from '../../../../shared/french-datetime';

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
      // ⚠️ Borne HAUTE ajoutée le 2026-08-13. `title`/`subject` étaient bornés à 200 sur la
      // ligne voisine, ce champ ne l'était pas — asymétrie relevée par l'audit, et c'est le
      // champ VOLUMINEUX. Rien en aval ne tronque : ni les assainisseurs de document ni les
      // adaptateurs d'envoi. Un contenu non borné est persisté, relu, et repart dans la
      // fenêtre du modèle, sur un système dont la contrainte dominante EST le budget de
      // tokens.
      body: z.string().min(1).max(5000).describe('rédige-le, ne le demande pas'),
      scheduledAt: z.string().describe('ISO 8601, dans le futur'),
      channel: z.enum(TRANSPORTED_CHANNELS).default('email'),
      recipientType: z.enum(RECIPIENT_TYPES).default('employee'),
    }),
    execute: async (data, _ctx) => {
      // ─────────────────────────────────────────────────────────────────────
      // FRONTIÈRE D'AUTORISATION — avant toute résolution, avant toute écriture
      // ─────────────────────────────────────────────────────────────────────
      // Ajoutée le 2026-08-18. Cet outil était, avec `updateOnboardingStatus`, le SEUL
      // écrivain exposé à un agent qui ne regardait pas qui demande — alors que son jumeau
      // `sendNotification` a sa garde depuis le 2026-08-13, et que les deux écrivent dans
      // la MÊME table.
      //
      // Ce que l'absence permettait : écrire un `subject` et un `body` de 5 000 caractères
      // dans `notifications`, sur le `recipientId` d'un TIERS. Ces lignes ressortent ensuite
      // par `getNotificationHistory` — c'est donc une écriture arbitraire dans l'historique
      // de quelqu'un d'autre, relue plus tard comme un fait.
      //
      // ⚠️ L'ABSENCE de niveau vaut autorisation, comme dans `send-notification.ts:117` :
      // hors Slack il n'y a pas de demandeur à évaluer.
      //
      // ⚠️ Le refus tombe AVANT la résolution du destinataire : sans cela, « destinataire
      // inconnu » et « non autorisé » deviendraient deux verdicts distinguables, donc un
      // oracle d'annuaire — le défaut déjà fermé sur `getEmployeeProfile`.
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
        // ⚠️ LE JOUR DE LA SEMAINE EST CALCULÉ ICI, et c'est un correctif mesuré en production
        // le 2026-08-19 : l'agent avait répondu « à 09 h 00 le lundi 22 août 2026 », alors que
        // le 22 août 2026 est un SAMEDI. Il écrivait le libellé lui-même, à côté d'une date
        // qu'il avait calculée, et rien ne confrontait les deux. `recruitmentAgent` ne peut pas
        // commettre cette faute — son libellé vient d'un gabarit — et il a produit au même
        // moment « mardi 15 septembre 2026 », exact.
        //
        // Coût : ≈ 15 tokens de tool-result, indépendants de la date. Ce qu'ils achètent, c'est
        // qu'une erreur de transcription devienne VISIBLE pour la personne qui relit.
        scheduledLabel: frenchFullLabel(new Date(when), DISPLAY_TIMEZONE),
        stored: true,
        willBeSentAutomatically: false,
      };
    },
  });
}

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { NotificationRepository } from '../../domain/ports/notification.repository';
import type { EmployeeRepository } from '../../domain/ports/employee.repository';
import type { EmailProvider, ChatProvider } from '../../domain/ports/providers';
import type { SlackWorkspaceProvider } from '../../domain/ports/slack-workspace.port';
import { createNotification } from '../../domain/entities/notification';
import { uuidSchema } from '../../../../shared/validation';
import { logger } from '../../../../shared/logger';
import { NotificationChannel, NotificationStatus, RecipientType } from '../../../../shared/types';
import { NotFoundError } from '../../../../shared/errors';

/**
 * Envoi de notification — outil exposé au LLM.
 *
 * ## Modèle de menace
 *
 * Cet outil est atteignable depuis un message Slack arbitraire : `slack-events.handler.ts`
 * route tout message contenant « email | message | notification | rappel » vers
 * `notificationAgent`, qui reçoit le texte brut de l'utilisateur. Toute valeur produite par
 * le LLM doit donc être considérée comme contrôlée par un attaquant.
 *
 * Conséquence : **l'adresse de destination n'est jamais un paramètre**. Le schéma d'entrée
 * n'expose que `recipientId` ; l'email et le compte Slack sont résolus côté serveur depuis
 * l'annuaire (`EmployeeRepository`). Le LLM peut choisir *à qui parmi les employés
 * enregistrés* on écrit, jamais *à quelle adresse*.
 *
 * ## Deux phases, deux régimes d'erreur
 *
 * 1. **Résolution** — échoue BRUYAMMENT (throw). Un `recipientId` inconnu, ou un compte Slack
 *    introuvable, interrompt l'outil : aucun envoi, aucun enregistrement. On n'ajoute
 *    surtout pas un chemin silencieux de plus (cf. le piège `emailSent: false` documenté
 *    dans CLAUDE.md, où un échec d'email laissait le workflow renvoyer `status: 'success'`).
 * 2. **Envoi** — un échec de transport (SMTP indisponible, API Slack en erreur) est enregistré
 *    en base avec `status: Failed`. C'est une panne opérationnelle, pas une tentative d'abus.
 */
export function makeSendNotification(
  repo: NotificationRepository,
  employeeRepo: EmployeeRepository,
  emailProvider: EmailProvider,
  chatProvider: ChatProvider,
  slackWorkspace: SlackWorkspaceProvider,
) {
  return createTool({
    id: 'sendNotification',
    // Description et `describe()` sont réémis à CHAQUE aller-retour : on n'y garde que
    // ce que le nom du champ ne dit pas déjà. Ce qui reste est le contrat de sécurité
    // (destinataire par UUID, jamais par adresse) — il doit rester lisible par le modèle.
    description:
      'Envoie une notification (email/Slack/in-app) à un employé déjà enregistré, ' +
      'désigné par son recipientId — jamais par une adresse.',
    inputSchema: z.object({
      // Pas de `recipientEmail` ni de `recipientSlackId` : voir le modèle de menace ci-dessus.
      // Un LLM qui les émettrait quand même les verrait supprimés par Zod (`z.object` retire
      // les clés inconnues), et `execute` ne les lit de toute façon jamais.
      recipientId: uuidSchema.describe(
        'UUID annuaire (via getEmployeeProfile) ; adresse résolue côté serveur.',
      ),
      recipientType: z.nativeEnum(RecipientType),
      channel: z.nativeEnum(NotificationChannel),
      subject: z.string().min(1).max(200),
      body: z.string().min(1),
    }),
    execute: async (data, _ctx) => {
      logger.info('Envoi notification', {
        recipientId: data.recipientId,
        recipientType: data.recipientType,
        channel: data.channel,
        subject: data.subject,
      });

      // Un LLM peut émettre des champs hors schéma lors d'un appel direct (hors validation
      // Mastra). On ne les utilise pas, mais on les journalise : une adresse proposée par le
      // modèle est un signal de tentative d'injection.
      const supplied = data as Record<string, unknown>;
      if (supplied.recipientEmail !== undefined || supplied.recipientSlackId !== undefined) {
        logger.warn(
          'Destination fournie par le modèle ignorée — la résolution se fait depuis la base',
          { recipientId: data.recipientId, channel: data.channel },
        );
      }

      // ---------------------------------------------------------------------
      // Phase 1 — Résolution (échoue bruyamment)
      // ---------------------------------------------------------------------

      // `recipientId` désigne TOUJOURS la personne à notifier, quel que soit `recipientType`.
      // Un manager est lui-même une ligne de `employees` (la table porte un `manager_id`
      // auto-référent), il se résout donc exactement comme un employé. On n'interprète
      // jamais `recipientType: manager` comme « le manager DE cet identifiant » : l'annuaire
      // ne permet pas de lever l'ambiguïté entre les deux lectures, et se tromper enverrait
      // le message à la mauvaise personne. Si un manager (ou un destinataire `hr`, `admin`,
      // `team`, `department`) n'a pas d'enregistrement d'annuaire, on échoue — jamais de
      // repli sur une valeur proposée par le modèle.
      const recipient = await employeeRepo.findById(data.recipientId);
      if (!recipient) {
        logger.error("Destinataire introuvable dans l'annuaire — envoi refusé", {
          recipientId: data.recipientId,
          recipientType: data.recipientType,
          channel: data.channel,
        });
        throw new NotFoundError('Destinataire introuvable', data.recipientId);
      }

      let destination: string | null = null;

      if (data.channel === NotificationChannel.Email) {
        if (!recipient.email) {
          throw new NotFoundError("Adresse email absente de l'annuaire", data.recipientId);
        }
        destination = recipient.email;
      } else if (data.channel === NotificationChannel.Slack) {
        // Le compte Slack se déduit de l'email d'annuaire : le LLM ne choisit ni le canal
        // ni l'utilisateur. `chat.postMessage` accepte un identifiant utilisateur et ouvre
        // la conversation directe correspondante.
        const member = await slackWorkspace.findUserByEmail(recipient.email);
        if (!member?.id) {
          logger.error('Compte Slack introuvable pour le destinataire — envoi refusé', {
            recipientId: data.recipientId,
          });
          throw new NotFoundError('Compte Slack du destinataire introuvable', data.recipientId);
        }
        destination = member.id;
      }

      // ---------------------------------------------------------------------
      // Phase 2 — Envoi (un échec de transport est enregistré, pas propagé)
      // ---------------------------------------------------------------------
      let status = NotificationStatus.Sent;

      try {
        if (data.channel === NotificationChannel.Email) {
          await emailProvider.sendEmail(destination!, data.subject, data.body);
        } else if (data.channel === NotificationChannel.Slack) {
          await chatProvider.sendMessage(destination!, `*${data.subject}*\n\n${data.body}`);
        }
        // Les autres canaux (in_app, teams, push, sms, webhook) ne sont pas transportés ici :
        // la notification est seulement persistée.
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Erreur inconnue';
        logger.error("Erreur lors de l'envoi de la notification", {
          error: message,
          recipientId: data.recipientId,
          channel: data.channel,
        });
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
        updatedAt: new Date().toISOString(),
      };

      await repo.save(sent);
      logger.info('Notification enregistrée', { id: sent.id, status });
      return sent;
    },
  });
}

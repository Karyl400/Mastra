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
import { canPerformSideEffects } from '../../../../shared/slack-request-context';

/**
 * Canaux RÉELLEMENT transportés par cet outil.
 *
 * `NotificationChannel` en compte sept ; cinq (`teams`, `in_app`, `push`, `sms`,
 * `webhook`) n'ont AUCUN transport ici et aucun lecteur ailleurs dans le produit.
 * Les exposer coûtait deux fois : en tokens (l'énumération est réémise à chaque
 * aller-retour) et surtout en dialogue — le « tu préfères quel canal (email, Slack,
 * in-app) ? » observé en production le 2026-08-11 est littéralement cette
 * énumération remontée à l'humain. Un canal qu'on ne sait pas acheminer n'a rien à
 * faire dans le schéma offert au modèle.
 *
 * `z.enum` LOCAL et non `z.nativeEnum(NotificationChannel)` : on ne touche pas à
 * l'énumération partagée de `src/shared/types.ts`, qui décrit le domaine, pas ce que
 * cet outil sait faire.
 */
const TRANSPORTED_CHANNELS = ['email', 'slack'] as const;

/**
 * Types de destinataire acceptés — restreints à ceux qui peuvent avoir une ligne
 * d'annuaire. `team` et `department` n'en ont jamais : les offrir revenait à
 * proposer au modèle un chemin dont la seule issue est un `NotFoundError`.
 */
const RECIPIENT_TYPES = ['employee', 'manager', 'hr', 'admin'] as const;

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
      'Envoie un message à un employé enregistré, désigné par son recipientId — ' +
      'jamais par une adresse.',
    inputSchema: z.object({
      // Pas de `recipientEmail` ni de `recipientSlackId` : voir le modèle de menace ci-dessus.
      // Un LLM qui les émettrait quand même les verrait supprimés par Zod (`z.object` retire
      // les clés inconnues), et `execute` ne les lit de toute façon jamais.
      recipientId: uuidSchema.describe('UUID annuaire ; adresse résolue côté serveur.'),
      // ⚠️ DÉROGATION DE RÉDACTION, POSÉE PAR CHAMP — jamais dans les instructions de
      // l'agent. `AGENT_ANTI_INVENTION_BLOCK` lui interdit d'inventer une donnée absente ;
      // c'est juste pour un email ou un UUID, qui se RETROUVENT, et faux pour une prose,
      // qui se PRODUIT. Poser « compose le corps toi-même » dans le prompt contredirait
      // frontalement cette règle et reviendrait à tirer à pile ou face à chaque tour. Ici,
      // la dérogation ne porte que sur les deux champs qui sont effectivement de la prose.
      subject: z.string().min(1).max(200).describe('rédige-le, ne le demande pas'),
      // ⚠️ Borne HAUTE ajoutée le 2026-08-13. `title`/`subject` étaient bornés à 200 sur la
      // ligne voisine, ce champ ne l'était pas — asymétrie relevée par l'audit, et c'est le
      // champ VOLUMINEUX. Rien en aval ne tronque : ni les assainisseurs de document ni les
      // adaptateurs d'envoi. Un contenu non borné est persisté, relu, et repart dans la
      // fenêtre du modèle, sur un système dont la contrainte dominante EST le budget de
      // tokens.
      body: z.string().min(1).max(5000).describe('rédige-le, ne le demande pas'),
      // Défauts, comme `generateDocument` (`format` → pdf, `deliverTo` → slack), le seul
      // outil de la campagne qui ait abouti. Un champ obligatoire sans défaut est une
      // question posée à l'humain ; il n'en reste que trois, et les trois sont
      // irremplaçables.
      channel: z.enum(TRANSPORTED_CHANNELS).default('email'),
      recipientType: z.enum(RECIPIENT_TYPES).default('employee'),
    }),
    execute: async (data, _ctx) => {
      // ─────────────────────────────────────────────────────────────────────
      // FRONTIÈRE D'AUTORISATION — avant toute résolution, avant toute E/S
      // ─────────────────────────────────────────────────────────────────────
      // C'est LE tool à protéger en premier. Il fait partir un email depuis le compte Gmail
      // de l'entreprise, SPF/DKIM parfaitement alignés : entre les mains d'un invité externe
      // c'est un relais de hameçonnage authentifié. Son invariant historique — n'accepter
      // qu'un UUID, jamais une adresse — empêche de choisir la CIBLE, mais n'empêchait
      // personne de déclencher l'envoi.
      //
      // Le niveau d'accès vient du `requestContext`, canal que le modèle ne peut pas écrire.
      // ⚠️ L'ABSENCE de niveau vaut autorisation : hors Slack (workflow, playground, test,
      // route `/api/*` déjà derrière un jeton) il n'y a pas de demandeur à évaluer, et
      // refuser y casserait le parcours d'onboarding qui envoie l'email de bienvenue.
      if (!canPerformSideEffects(_ctx?.requestContext)) {
        logger.warn('sendNotification refusé : le demandeur n’a pas le niveau requis', {
          recipientId: data.recipientId,
        });
        // On INSTRUIT plutôt que de lever. Une exception remonterait au modèle comme une
        // panne, qu'il raconterait comme telle ou qu'il réessaierait — deux allers-retours
        // gâchés sur un budget de ≈19 messages/jour. Ici il lit un refus et peut le dire.
        return {
          sent: false,
          reason: 'not_authorized',
          hint: "Cette action est réservée aux membres de l'organisation. Dis-le simplement, ne réessaie pas.",
        };
      }

      // Les défauts du schéma sont appliqués par la validation Mastra ; ces replis
      // couvrent l'appel direct (tests, workflows) qui court-circuite le parseur.
      const channel = data.channel ?? 'email';
      const recipientType = (data.recipientType ?? 'employee') as RecipientType;

      logger.info('Envoi notification', {
        recipientId: data.recipientId,
        recipientType,
        channel,
        subject: data.subject,
      });

      // Un LLM peut émettre des champs hors schéma lors d'un appel direct (hors validation
      // Mastra). On ne les utilise pas, mais on les journalise : une adresse proposée par le
      // modèle est un signal de tentative d'injection.
      const supplied = data as Record<string, unknown>;
      if (supplied.recipientEmail !== undefined || supplied.recipientSlackId !== undefined) {
        logger.warn(
          'Destination fournie par le modèle ignorée — la résolution se fait depuis la base',
          { recipientId: data.recipientId, channel },
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
      // le message à la mauvaise personne. Si un manager (ou un destinataire `hr`, `admin`)
      // n'a pas d'enregistrement d'annuaire, on échoue — jamais de repli sur une valeur
      // proposée par le modèle.
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
      // `Sent` était posé AVANT le `try`, donc par DÉFAUT : les cinq canaux non
      // transportés repartaient « envoyé », horodatés, sans qu'aucun octet ne parte —
      // troisième occurrence dans ce dépôt du même défaut (`emailSent: false` avec
      // `status: 'success'`, `documents.content` perdu en silence). Le statut est
      // désormais posé APRÈS l'`await` du transport : aucun chemin ne peut plus
      // atteindre `Sent` sans qu'un fournisseur ait réellement rendu la main.
      let status: NotificationStatus;

      try {
        if (channel === 'email') {
          await emailProvider.sendEmail(destination, data.subject, data.body);
        } else {
          await chatProvider.sendMessage(destination, `*${data.subject}*\n\n${data.body}`);
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

      // Verdict PROJETÉ. On ne renvoie ni `subject` ni `body` : c'est le modèle qui
      // vient de les écrire, les lui refacturer à chaque aller-retour suivant est un
      // coût pur (même défaut que `documents.content`). `status` porte à lui seul la
      // différence entre « parti » et « pas parti ».
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

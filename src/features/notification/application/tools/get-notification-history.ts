/**
 * Historique des notifications — outil exposé au LLM.
 *
 * ## Pourquoi une projection ET une borne
 *
 * Ce tool renvoyait les lignes du repository TELLES QUELLES : 18 colonnes, `body` non
 * borné, et un `limit` par défaut à 50. Mesuré : **~10 223 tokens** pour 50 lignes.
 * Le plafond réel de Groq est de **100 000 tokens par JOUR** (les en-têtes de la
 * campagne du 2026-08-11 : `TPD: Limit 100000, Used 98207`) — un seul appel brûlait
 * donc 10 % de la journée entière, et le résultat restait ensuite dans l'historique de
 * TOUS les tours suivants, où il était repayé à chaque aller-retour.
 *
 * C'est exactement le défaut corrigé pour `getEmployeeProfile` (2 506 → 329 tokens) et
 * jamais appliqué ici. Le remède est le même que dans
 * `src/features/employee/application/mappers/task-summary.mapper.ts` :
 *
 * 1. **BORNE** — au plus `MAX_NOTIFICATIONS_IN_RESULT` entrées, pour que la taille du
 *    résultat soit INDÉPENDANTE du nombre de notifications en base.
 * 2. **PROJECTION** — on énumère ce qu'on expose plutôt que ce qu'on retire : une
 *    colonne ajoutée demain ne fuite pas toute seule. `body` en particulier ne sort
 *    JAMAIS — c'est le champ le plus lourd, et c'est le modèle lui-même qui l'a écrit :
 *    le lui renvoyer est un coût pur (même défaut que `documents.content`).
 * 3. **SIGNALISATION** — `total` / `shown` disent que la liste est tronquée. Sans eux le
 *    modèle conclurait qu'il a tout vu.
 * 4. **ORDRE** — il n'y en avait aucun : le repository rend les lignes dans l'ordre du
 *    `Map` ou de la base. Deux appels identiques pouvaient donner deux réponses
 *    différentes. On trie du plus récent au plus ancien.
 *
 * Le paramètre `limit` a été retiré du schéma : il ne servait qu'à laisser le modèle
 * choisir combien on lui facture, il coûtait des tokens à chaque aller-retour, et la
 * borne doit être une propriété du serveur, pas une préférence du modèle.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { NotificationRepository } from '../../domain/ports/notification.repository';
import type { Notification } from '../../domain/entities/notification';
import { uuidSchema, emailSchema } from '../../../../shared/validation';
import { logger } from '../../../../shared/logger';
import { canReadPersonRecord } from '../../../../shared/slack-request-context';
import type { NotificationChannel, NotificationStatus } from '../../../../shared/types';

/**
 * Consigne rendue quand le demandeur n'a pas le droit de lire l'historique de cette personne.
 * Même rédaction que dans `get-employee-profile.ts` — une seule formulation, pour qu'elles ne
 * divergent pas.
 */
const NOT_AUTHORIZED_HINT =
  "Tu n'as pas accès aux messages reçus par cette personne. Dis-le simplement, sans détour " +
  'et sans inventer de motif. Ne réessaie pas avec un autre outil et ne reformule pas la ' +
  'demande.';

/**
 * Nombre maximal de notifications rendues.
 *
 * Cinq suffit à la seule question réelle — « lui a-t-on déjà écrit à ce sujet ? »,
 * posée par les instructions de `notificationAgent` pour éviter les doublons.
 */
export const MAX_NOTIFICATIONS_IN_RESULT = 5;

/** Au-delà, un objet n'apporte plus rien au modèle et coûte à chaque tour. */
const SUBJECT_MAX_CHARS = 80;

/**
 * Vue minimale d'une notification, telle qu'exposée au LLM.
 *
 * Pas d'`id` : AUCUN tool de ce dépôt ne consomme un identifiant de notification.
 * Le rendre coûtait 36 caractères par ligne — le champ le plus lourd après le
 * sujet — pour une clé que le modèle ne peut que recopier.
 */
export interface NotificationSummary {
  readonly channel: NotificationChannel;
  readonly status: NotificationStatus;
  readonly subject: string;
  /**
   * Date la plus significative : envoyée si elle l'a été, sinon prévue, sinon créée.
   * Un seul champ de date au lieu de quatre — le modèle n'a pas à arbitrer entre
   * `sentAt`, `scheduledAt`, `createdAt` et `updatedAt`.
   */
  readonly at: string;
}

export interface NotificationHistoryPage {
  readonly notifications: NotificationSummary[];
  /** Nombre total de notifications du destinataire, AVANT troncature. */
  readonly total: number;
  /** Nombre réellement présent dans `notifications`. */
  readonly shown: number;
}

function dateOf(n: Notification): string {
  return n.sentAt ?? n.scheduledAt ?? n.createdAt;
}

function toSummary(n: Notification): NotificationSummary {
  const subject =
    n.subject.length > SUBJECT_MAX_CHARS
      ? `${n.subject.slice(0, SUBJECT_MAX_CHARS)}...`
      : n.subject;
  return { channel: n.channel, status: n.status, subject, at: dateOf(n) };
}

/**
 * @param employeeRepo OPTIONNEL, et seulement pour résoudre un email en identifiant.
 *
 * Mesuré en production le 2026-08-15 : « historique des notifications de <email> » coûtait
 * TROIS étapes — `findEmployeeByEmail`, puis `getNotificationHistory`, puis la réponse — pour
 * 4 424 tokens. L'entrée étant CUMULATIVE (chaque étape réémet tout le contexte), l'étape
 * intermédiaire vaut à elle seule ≈ 1 500 tokens. Même défaut, même correctif que
 * `getEmployeeProfile`.
 *
 * Le paramètre est optionnel pour ne pas casser les appelants existants : sans lui, seul le
 * chemin `recipientId` fonctionne et le chemin email INSTRUIT au lieu d'échouer.
 */
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
      const email = data.email ? String(data.email).trim().toLowerCase() : undefined;

      if (!data.recipientId && !email) {
        return {
          notifications: [],
          total: 0,
          shown: 0,
          reason: 'missing_identifier' as const,
          hint: "Précise QUI : l'email professionnel ou l'identifiant du destinataire.",
        };
      }

      // ── Chemin EMAIL ──────────────────────────────────────────────────────
      // Même construction anti-ORACLE que `getEmployeeProfile` : l'identifiant RÉSOLU (ou
      // `null`) est passé à la garde, si bien qu'un demandeur non autorisé reçoit le MÊME
      // verdict que l'adresse désigne quelqu'un ou personne. Sans cela, le tool permettrait
      // d'énumérer l'annuaire une adresse à la fois.
      let recipientId = data.recipientId;

      if (!recipientId && email) {
        if (!employeeRepo) {
          return {
            notifications: [],
            total: 0,
            shown: 0,
            reason: 'missing_identifier' as const,
            hint: "Donne l'identifiant du destinataire : la recherche par email n'est pas disponible ici.",
          };
        }

        const resolved = await employeeRepo.findByEmail(email);

        if (!canReadPersonRecord(_ctx?.requestContext, resolved?.id ?? null)) {
          logger.warn('Lecture d’historique refusée — demandeur non autorisé (par email)');
          return {
            notifications: [],
            total: 0,
            shown: 0,
            reason: 'not_authorized' as const,
            hint: NOT_AUTHORIZED_HINT,
          };
        }

        if (!resolved) {
          return {
            notifications: [],
            total: 0,
            shown: 0,
            reason: 'recipient_not_found' as const,
            hint: "Aucun employé ne porte cette adresse. Ne l'invente pas : demande-la.",
          };
        }

        recipientId = resolved.id;
      }

      // AVANT toute lecture en base — voir `canReadPersonRecord`. L'historique des messages
      // reçus par quelqu'un dit ce qu'on lui a écrit et quand : c'est une donnée personnelle
      // au même titre que son dossier.
      if (!canReadPersonRecord(_ctx?.requestContext, recipientId)) {
        logger.warn('Lecture d’historique refusée — demandeur non autorisé', {
          recipientId,
        });
        return {
          notifications: [],
          total: 0,
          shown: 0,
          reason: 'not_authorized' as const,
          hint: NOT_AUTHORIZED_HINT,
        };
      }

      logger.info('Récupération historique notifications', { recipientId });
      const all = await repo.findByRecipient(recipientId as string);

      // Tri déterministe : date décroissante, puis `id` décroissant pour départager
      // deux notifications de même horodatage. Sans ce second critère, deux appels
      // identiques pouvaient rendre deux ordres différents.
      const sorted = [...all].sort((a, b) => {
        const byDate = dateOf(b).localeCompare(dateOf(a));
        return byDate !== 0 ? byDate : b.id.localeCompare(a.id);
      });

      const notifications = sorted.slice(0, MAX_NOTIFICATIONS_IN_RESULT).map(toSummary);
      return { notifications, total: all.length, shown: notifications.length };
    },
  });
}

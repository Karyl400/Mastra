import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { logger } from '../../../../shared/logger';
import { readSlackContext, writeExcerptCoverage } from '../../../../shared/slack-request-context';
import {} from '../../../directory/domain/services/access-policy';
import type { ConversationExcerpt } from '../../domain/entities/conversation-excerpt';
import {
  ChannelUnavailableError,
  type ChannelHistoryPort,
  type ChannelUnavailableReason,
} from '../../domain/ports/channel-history.port';
import type {
  DirectoryPerson,
  PersonDirectoryPort,
} from '../../domain/ports/person-directory.port';
import {
  authorizeChannelRead,
  type DisclosureReason,
  type Requester,
} from '../../domain/services/disclosure-policy';
import { describeCoverageForHuman, projectExcerpts } from '../../domain/services/excerpt-budget';
import {
  KNOWLEDGE_LOOKBACK_MS,
  KNOWLEDGE_SCAN_LIMIT,
} from '../../domain/value-objects/retrieval-window';
import { wrapRetrievedContent } from '../services/untrusted-excerpt.service';

/**
 * `getChannelHistory` — ce qui s'est dit récemment dans un canal.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ⚠️ LE DEPUTY CONFUS SE FERME ICI, ET NULLE PART AILLEURS
 * ────────────────────────────────────────────────────────────────────────────
 * Le bot est membre de `#engineer-karyl`, privé. Sans le contrôle ci-dessous, un
 * invité mono-canal lui écrit en DM et obtient ce canal — parce que le BOT y a
 * accès (`PLAN-ARCHITECTURE.md` §4.1).
 *
 * L'ordre des opérations dans `execute` EST le correctif :
 *
 *   1. identifier le demandeur (`requestContext`, jamais le prompt) ;
 *   2. demander à Slack si CE demandeur est membre du canal ;
 *   3. seulement ensuite, lire quoi que ce soit.
 *
 * On ne réimplémente pas l'ACL Slack, on la miroite : elle est déjà correcte, et
 * elle est la seule autorisation qui fonctionne réellement dans ce système.
 * Inverser 2 et 3 « pour éviter un appel API » suffirait à rouvrir la faille —
 * le contenu serait chargé, donc journalisé, donc en mémoire du processus, avant
 * qu'on sache s'il peut être montré.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ENTRÉE PAR IDENTIFIANT DE CANAL — demande explicite du propriétaire
 * ────────────────────────────────────────────────────────────────────────────
 * Et non par nom. Un nom se résout par `conversations.list`, qui énumère les
 * canaux que le BOT voit — y compris privés : la résolution elle-même
 * divulguerait leur existence, avant tout contrôle. L'identifiant, lui, ne
 * s'obtient qu'en ayant déjà accès au canal.
 */

export interface GetChannelHistoryDeps {
  readonly directory: PersonDirectoryPort;
  readonly channels: ChannelHistoryPort;
  /** Voir `get-user-conversations.ts` : lue à chaque appel, jamais figée au câblage. */
}

/**
 * `C…` public, `G…` privé hérité, `D…` message direct.
 *
 * ⚠️ Pas de `\p{L}` ni de classe Unicode : le parseur de schémas du Vercel AI SDK
 * casse dessus avec Zod épinglé à 3.25.76.
 */
const CHANNEL_ID_RE = /^[CGD][A-Z0-9]{4,}$/i;

type ChannelVerdict = DisclosureReason | ChannelUnavailableReason | 'no_message';

const VERDICT_HINTS: Partial<Record<ChannelVerdict, string>> = {
  no_requester: "Hors Slack : pas d'identité, donc rien à divulguer. Dis-le, ne réessaie pas.",
  not_channel_member: "Tu ne montres un canal qu'à ses membres. Ne dis rien de son contenu.",
  requester_denied: 'Compte non autorisé.',
  bot_not_in_channel: 'Invite-moi dans ce canal pour que je puisse le lire.',
  channel_not_found: 'Cet identifiant ne désigne aucun canal.',
  unavailable: 'Slack indisponible. Réessayer a un sens.',
  no_message: 'Aucun message exploitable dans la fenêtre consultée.',
};

function refuse(reason: ChannelVerdict) {
  const hint = VERDICT_HINTS[reason];
  return hint ? { found: false as const, reason, hint } : { found: false as const, reason };
}

export function makeGetChannelHistory(deps: GetChannelHistoryDeps) {
  return createTool({
    id: 'getChannelHistory',
    description: "Retrouve les derniers messages d'un canal dont on te donne l'identifiant.",
    inputSchema: z.object({
      channelId: z
        .string()
        .trim()
        .regex(CHANNEL_ID_RE, 'Identifiant de canal Slack attendu (C…, G… ou D…)')
        .describe('Identifiant du canal, pas son nom (ex. CMLKC4S5T).'),
    }),
    execute: async (data, ctx) => {
      const slack = readSlackContext(ctx?.requestContext);
      if (!slack?.slackUserId) {
        logger.warn('Knowledge — récupération refusée : aucun demandeur identifié', {
          scope: 'channel',
          channelId: data.channelId,
        });
        return refuse('no_requester');
      }

      const requesterId = slack.slackUserId;
      const channelId = data.channelId.trim().toUpperCase();

      let requesterPerson: DirectoryPerson | null = null;
      try {
        requesterPerson = await deps.directory.findBySlackUserId(requesterId);
      } catch (error) {
        logger.warn('Knowledge — annuaire indisponible, demandeur traité comme inconnu', {
          requesterId,
          error,
        });
      }

      const requester: Requester = { slackUserId: requesterId, subject: requesterPerson };

      // ── L'APPARTENANCE DU DEMANDEUR, avant toute lecture ────────────────────
      // Une erreur ici vaut NON. Fail-closed, à l'inverse du reste du dépôt :
      // ailleurs une indisponibilité coûte une livraison, ici elle coûterait la
      // confidentialité d'un canal privé.
      // Déclarée sans valeur, à dessein : le `catch` RETOURNE, donc aucune exécution n'atteint
      // la suite sans avoir affecté cette variable. Un `= false` initial se lirait comme le
      // défaut sûr alors qu'il ne serait jamais lu — et masquerait que la garantie fail-closed
      // vient du `return refuse('unavailable')`, pas de l'initialisation.
      let isMember: boolean;
      try {
        isMember = await deps.channels.isMember(channelId, requesterId);
      } catch (error) {
        logger.error("Knowledge — contrôle d'appartenance impossible, accès refusé", {
          requesterId,
          channelId,
          error,
        });
        return refuse('unavailable');
      }

      const verdict = authorizeChannelRead(requester, isMember);
      if (!verdict.allowed) {
        logger.warn('Knowledge — récupération refusée par la politique de divulgation', {
          scope: 'channel',
          requesterId,
          channelId,
          reason: verdict.reason,
        });
        return refuse(verdict.reason);
      }

      let messages;
      try {
        messages = await deps.channels.fetchRecent(channelId, {
          sinceMs: KNOWLEDGE_LOOKBACK_MS,
          limit: KNOWLEDGE_SCAN_LIMIT,
        });
      } catch (error) {
        const reason: ChannelUnavailableReason =
          error instanceof ChannelUnavailableError ? error.reason : 'unavailable';
        logger.error("Knowledge — lecture de l'historique de canal en échec", {
          requesterId,
          channelId,
          reason,
          error,
        });
        return refuse(reason);
      }

      if (messages.length === 0) return refuse('no_message');

      const excerpts: ConversationExcerpt[] = messages.map((message) => ({
        source: 'channel',
        speaker: message.authorLabel,
        text: message.text,
        at: message.at,
      }));

      const { lines, shown, coverage } = projectExcerpts(excerpts);

      // JOURNALISATION RGPD — qui a lu quel canal, quand, sur quelle base. Jamais
      // le contenu : une trace d'accès qui recopie la donnée devient la fuite
      // qu'elle est censée documenter.
      logger.info("Knowledge — récupération de l'historique d'un canal", {
        scope: 'channel',
        requesterId,
        channelId,
        reason: verdict.reason,
        scanned: messages.length,
        shown,
      });

      // ── LA COUVERTURE, DITE À L'HUMAIN — quatrième forme, 2026-08-18 ──────
      // Les trois précédentes dépendaient toutes du modèle et ont été mesurées en échec :
      // champ `coverage` ignoré, champ `hint` ignoré, préface lue mais non relayée — le
      // 2026-08-18, « Aucun obstacle concret n'est mentionné » sur 6 messages vus sur 8,
      // exactement ce que la préface interdit. Le `RequestContext` est un canal SERVEUR :
      // le handler accole la note lui-même, le modèle n'est plus sur le chemin. Coût NUL.
      const humanCoverage = describeCoverageForHuman(excerpts, shown);
      if (humanCoverage) writeExcerptCoverage(ctx?.requestContext, humanCoverage);

      return {
        found: true,
        conversation: wrapRetrievedContent(lines, coverage),
        shown,
        scanned: messages.length,
        // ⚠️ Émise sous le nom `hint`, et ce nom est le fruit d'une MESURE en production.
        // Le champ s'appelait `coverage` : le modèle l'a purement ignoré — 23 messages
        // humains, 6 montrés, et une réponse qui affirmait résumer « ce qui s'est dit ».
        // Un champ nommé comme une métadonnée se lit comme une métadonnée. `hint` est en
        // revanche suivi à la lettre partout ailleurs dans ce dépôt (vérifié le même jour
        // sur `scheduleCandidateInterview`, dont le « ne dis jamais qu'il est envoyé » a
        // été respecté). Payée UNIQUEMENT quand tout n'a pas été montré.
        ...(coverage ? { hint: coverage } : {}),
      };
    },
  });
}

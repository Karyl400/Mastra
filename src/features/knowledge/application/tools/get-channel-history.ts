import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { logger } from '../../../../shared/logger';
import {
  readSlackContext,
  writeExcerptCoverage,
  writeLoanDelivered,
} from '../../../../shared/slack-request-context';
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
import { buildNameLookup } from '../services/directory-names';
import type { DigestDeliveryPort } from '../../domain/ports/digest-delivery.port';

export interface GetChannelHistoryDeps {
  readonly directory: PersonDirectoryPort;
  readonly channels: ChannelHistoryPort;
  readonly digests?: DigestDeliveryPort;
}

export type DigestOutcome = 'delivered' | 'failed' | 'unavailable';

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

async function deliverDigest(
  digests: DigestDeliveryPort | undefined,
  request: {
    channelId: string;
    requesterId: string;
    target: { channel?: string; threadTs?: string };
    title: string;
    coverage: string;
    lines: string;
  },
): Promise<DigestOutcome> {
  if (!digests || !request.target.channel) return 'unavailable';

  try {
    const verdict = await digests.deliver(
      {
        channelId: request.channelId,
        title: request.title,
        coverage: request.coverage,
        lines: request.lines.split('\n').filter((line) => line.trim().length > 0),
      },
      {
        channel: request.target.channel,
        ...(request.target.threadTs ? { threadTs: request.target.threadTs } : {}),
      },
    );

    if (verdict.delivered) {
      logger.info('Knowledge — résumé de canal livré en document', {
        requesterId: request.requesterId,
        channelId: request.channelId,
        filename: verdict.filename,
      });
      return 'delivered';
    }

    logger.error('Knowledge — livraison du résumé en document impossible', {
      requesterId: request.requesterId,
      channelId: request.channelId,
      reason: verdict.reason,
    });
    return 'failed';
  } catch (error) {
    logger.error('Knowledge — livraison du résumé en document en échec', {
      requesterId: request.requesterId,
      channelId: request.channelId,
      error,
    });
    return 'failed';
  }
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
      asDocument: z
        .boolean()
        .optional()
        .describe('true pour joindre aussi un PDF du résumé dans ce fil.'),
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

      const nameLookup = await buildNameLookup(
        deps.directory,
        excerpts.map((excerpt) => excerpt.text),
      );
      const { lines, shown, coverage } = projectExcerpts(excerpts, nameLookup);

      logger.info("Knowledge — récupération de l'historique d'un canal", {
        scope: 'channel',
        requesterId,
        channelId,
        reason: verdict.reason,
        scanned: messages.length,
        shown,
      });

      const humanCoverage = describeCoverageForHuman(excerpts, shown);
      if (humanCoverage) writeExcerptCoverage(ctx?.requestContext, humanCoverage);

      const document = data.asDocument
        ? await deliverDigest(deps.digests, {
            channelId,
            requesterId,
            target: { channel: slack.channel, threadTs: slack.threadTs },
            title: `Résumé de la conversation`,
            coverage: humanCoverage ?? coverage ?? '',
            lines,
          })
        : undefined;

      if (document === 'delivered') writeLoanDelivered(ctx?.requestContext, 'channelDigest');

      return {
        found: true,
        conversation: wrapRetrievedContent(lines, coverage),
        shown,
        scanned: messages.length,
        ...(coverage ? { hint: coverage } : {}),
        ...(document ? { document } : {}),
      };
    },
  });
}

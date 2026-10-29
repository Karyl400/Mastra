import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { logger } from '../../../../shared/logger';
import {
  readSlackContext,
  writeExcerptCoverage,
  writeLoanDelivered,
} from '../../../../shared/slack-request-context';
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
import {
  KNOWLEDGE_LOOKBACK_MS,
  KNOWLEDGE_SCAN_LIMIT,
} from '../../domain/value-objects/retrieval-window';
import { wrapRetrievedContent } from '../services/untrusted-excerpt.service';
import type { DigestDeliveryPort } from '../../domain/ports/digest-delivery.port';
import { deliverDigest, type DigestOutcome } from './channel-digest-delivery';
import { projectChannelHistory } from './channel-history-excerpts';
import { refuse, type ChannelVerdict } from './channel-history-verdicts';
import { resolveNamedChannel } from './channel-name-lookup';

export type { DigestOutcome };

export interface GetChannelHistoryDeps {
  readonly directory: PersonDirectoryPort;
  readonly channels: ChannelHistoryPort;
  readonly digests?: DigestDeliveryPort;
}

const CHANNEL_ID_RE = /^[CGD][A-Z0-9]{4,}$/i;

async function authorizeRead(
  deps: GetChannelHistoryDeps,
  requesterId: string,
  channelId: string,
): Promise<
  { allowed: true; reason: DisclosureReason } | { allowed: false; reason: ChannelVerdict }
> {
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
    const reason: ChannelUnavailableReason =
      error instanceof ChannelUnavailableError ? error.reason : 'unavailable';
    logger.error("Knowledge — contrôle d'appartenance impossible, accès refusé", {
      requesterId,
      channelId,
      reason,
      error,
    });
    return { allowed: false, reason };
  }

  const verdict = authorizeChannelRead(requester, isMember);
  if (verdict.allowed) {
    return { allowed: true, reason: verdict.reason };
  }

  logger.warn('Knowledge — récupération refusée par la politique de divulgation', {
    scope: 'channel',
    requesterId,
    channelId,
    reason: verdict.reason,
  });
  return { allowed: false, reason: verdict.reason };
}

export function makeGetChannelHistory(deps: GetChannelHistoryDeps) {
  return createTool({
    id: 'getChannelHistory',
    description:
      "Retrouve les derniers messages d'un canal, désigné par son nom ou son identifiant.",
    inputSchema: z
      .object({
        channelId: z
          .string()
          .trim()
          .regex(CHANNEL_ID_RE, 'Identifiant de canal Slack attendu (C…, G… ou D…)')
          .optional()
          .describe('Identifiant du canal, quand la personne a écrit un jeton <#C…>.'),
        channelName: z
          .string()
          .trim()
          .min(2)
          .max(80)
          .optional()
          .describe('Nom du canal tel que la personne l’écrit (ex. engineer-karyl).'),
        asDocument: z
          .boolean()
          .optional()
          .describe('true pour joindre aussi un PDF du résumé dans ce fil.'),
      })
      .refine((input) => Boolean(input.channelId ?? input.channelName), {
        message: 'Donne le nom du canal, ou son identifiant si tu en as un.',
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

      const target = data.channelId
        ? { id: data.channelId.trim().toUpperCase() }
        : await resolveNamedChannel(deps.channels, requesterId, data.channelName);
      if ('refused' in target) {
        return refuse(target.refused);
      }
      const channelId = target.id;

      const verdict = await authorizeRead(deps, requesterId, channelId);
      if (!verdict.allowed) {
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

      if (messages.length === 0) {
        return refuse('no_message');
      }

      const { lines, shown, coverage, humanCoverage } = await projectChannelHistory(
        deps.directory,
        messages,
      );

      logger.info("Knowledge — récupération de l'historique d'un canal", {
        scope: 'channel',
        requesterId,
        channelId,
        reason: verdict.reason,
        scanned: messages.length,
        shown,
      });

      if (humanCoverage) {
        writeExcerptCoverage(ctx?.requestContext, humanCoverage);
      }

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

      if (document === 'delivered') {
        writeLoanDelivered(ctx?.requestContext, 'channelDigest');
      }

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

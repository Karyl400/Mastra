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
import { resolveChannelName } from '../../domain/services/channel-name-matching';
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

const CHANNEL_LOOKUP_LIMIT = 200;

type ChannelVerdict =
  DisclosureReason | ChannelUnavailableReason | 'no_message' | 'ambiguous_channel';

const VERDICT_HINTS: Partial<Record<ChannelVerdict, string>> = {
  no_requester: "Hors Slack : pas d'identité, donc rien à divulguer. Dis-le, ne réessaie pas.",
  not_channel_member:
    "C'est la personne qui demande qui n'est pas membre de ce canal — jamais toi. Dis-le d'elle, " +
    'pas de toi, et ne dis rien du contenu.',
  requester_denied: 'Compte non autorisé.',
  bot_not_in_channel:
    "Je ne suis pas dans ce canal, donc je n'ai rien lu et je ne peux rien en dire. " +
    'Dis-le simplement, et ne demande à personne de faire quoi que ce soit pour y remédier.',
  channel_not_found:
    "Aucun canal visible sous ce nom ou cet identifiant. Demande lequel, sans supposer qu'il " +
    "n'existe pas.",
  unavailable: 'Slack indisponible. Réessayer a un sens.',
  no_message: 'Aucun message exploitable dans la fenêtre consultée.',
  ambiguous_channel:
    'Plusieurs canaux portent ce début de nom. Demande lequel, en citant ceux que je propose.',
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

async function resolveNamedChannel(
  deps: GetChannelHistoryDeps,
  requesterId: string,
  wanted: string | undefined,
): Promise<{ id: string } | { refused: ChannelVerdict }> {
  let visible;
  try {
    visible = await deps.channels.listMemberChannels(requesterId, CHANNEL_LOOKUP_LIMIT);
  } catch (error) {
    logger.error('Knowledge — liste des canaux du demandeur illisible', { requesterId, error });
    return { refused: 'unavailable' };
  }

  const match = resolveChannelName(visible, wanted);

  if (!match) {
    logger.info('Knowledge — nom de canal non résolu parmi ceux du demandeur', {
      requesterId,
      visible: visible.length,
    });
    return { refused: 'channel_not_found' };
  }

  if ('ambiguous' in match) {
    logger.info('Knowledge — nom de canal ambigu', { requesterId, candidates: match.ambiguous });
    return { refused: 'ambiguous_channel' };
  }

  return { id: match.id };
}

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
  if (verdict.allowed) return { allowed: true, reason: verdict.reason };

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
        : await resolveNamedChannel(deps, requesterId, data.channelName);
      if ('refused' in target) return refuse(target.refused);
      const channelId = target.id;

      const verdict = await authorizeRead(deps, requesterId, channelId);
      if (!verdict.allowed) return refuse(verdict.reason);

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

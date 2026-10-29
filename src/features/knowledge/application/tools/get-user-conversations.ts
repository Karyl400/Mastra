import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { logger } from '../../../../shared/logger';
import { readSlackContext, writeExcerptCoverage } from '../../../../shared/slack-request-context';
import type { ConversationExcerpt } from '../../domain/entities/conversation-excerpt';
import type { BotMemoryReadPort } from '../../domain/ports/bot-memory.repository';
import type { PersonDirectoryPort } from '../../domain/ports/person-directory.port';
import {
  authorizeMemoryRead,
  authorizeOtherMemoryRead,
  mayDiscloseBotUtterances,
  type Requester,
} from '../../domain/services/disclosure-policy';
import { describeCoverageForHuman, projectExcerpts } from '../../domain/services/excerpt-budget';
import {
  KNOWLEDGE_LOOKBACK_MS,
  KNOWLEDGE_SCAN_LIMIT,
} from '../../domain/value-objects/retrieval-window';
import { wrapRetrievedContent } from '../services/untrusted-excerpt.service';
import { buildNameLookup } from '../services/directory-names';
import {
  designatesRequester,
  lookUpRequester,
  refuse,
  resolveTarget,
} from './user-conversations-admission';

export interface GetUserConversationsDeps {
  readonly directory: PersonDirectoryPort;
  readonly memory: BotMemoryReadPort;
}

export function makeGetUserConversations(deps: GetUserConversationsDeps) {
  return createTool({
    id: 'getUserConversations',
    description: 'Retrouve les échanges directs entre cette personne et toi.',
    inputSchema: z.object({
      person: z
        .string()
        .trim()
        .min(1)
        .max(254)
        .optional()
        .describe('Email ou identifiant Slack. Vide = la personne qui te parle.'),
    }),
    execute: async (data, ctx) => {
      const slack = readSlackContext(ctx?.requestContext);
      if (!slack?.slackUserId) {
        logger.warn('Knowledge — récupération refusée : aucun demandeur identifié', {
          scope: 'bot_memory',
        });
        return refuse('no_requester');
      }

      const requesterId = slack.slackUserId;

      const requesterPerson = await lookUpRequester(deps.directory, requesterId);

      const requester: Requester = { slackUserId: requesterId, subject: requesterPerson };

      const asked = data.person?.trim();

      const targetsRequester = !asked || designatesRequester(asked, requesterId, requesterPerson);

      const verdict = targetsRequester
        ? authorizeMemoryRead(requester, requesterId)
        : authorizeOtherMemoryRead(requester);

      if (!verdict.allowed) {
        logger.warn('Knowledge — récupération refusée par la politique de divulgation', {
          scope: 'bot_memory',
          requesterId,
          targetsRequester,
          reason: verdict.reason,
        });
        return refuse(verdict.reason);
      }

      const resolved = asked ? await resolveTarget(deps.directory, asked) : requesterPerson;

      if (resolved === 'unparsable') {
        return refuse('person_not_resolved');
      }

      const targetId = resolved?.slackUserId ?? (targetsRequester ? requesterId : null);
      if (!targetId) {
        return refuse('person_not_found');
      }

      const isSelf = targetId === requesterId;
      const dmChannelId =
        resolved?.dmChannelId ?? (isSelf && slack.channel.startsWith('D') ? slack.channel : null);

      if (!dmChannelId || !dmChannelId.startsWith('D')) {
        return refuse('no_recorded_conversation');
      }

      let turns;
      try {
        turns = await deps.memory.findRecentDirectTurns(dmChannelId, {
          sinceMs: KNOWLEDGE_LOOKBACK_MS,
          limit: KNOWLEDGE_SCAN_LIMIT,
        });
      } catch (error) {
        logger.error('Knowledge — lecture de la mémoire du bot en échec', {
          requesterId,
          targetId,
          error,
        });
        return refuse('memory_unavailable');
      }

      const disclosable = mayDiscloseBotUtterances(requester, targetId)
        ? turns
        : turns.filter((turn) => turn.role === 'user');

      const withheld = turns.length - disclosable.length;

      if (disclosable.length === 0) {
        return refuse('no_recorded_conversation');
      }

      const speaker = resolved?.displayName || targetId;
      const excerpts: ConversationExcerpt[] = disclosable.map((turn) => ({
        source: 'bot_memory',
        speaker: turn.role === 'assistant' ? 'Kisso' : speaker,
        text: turn.text,
        at: turn.at,
      }));

      const nameLookup = await buildNameLookup(
        deps.directory,
        excerpts.map((excerpt) => excerpt.text),
      );
      const { lines, shown, coverage } = projectExcerpts(excerpts, nameLookup);

      const hint = [
        withheld > 0
          ? "Tu ne vois que SES messages, pas tes réponses : c'est la règle, pas un vide."
          : undefined,
        coverage,
      ]
        .filter(Boolean)
        .join(' ');

      noteCoverageForHuman(ctx?.requestContext, excerpts, shown);

      logger.info('Knowledge — récupération de conversations directes', {
        scope: 'bot_memory',
        requesterId,
        targetId,
        reason: verdict.reason,
        scanned: turns.length,
        withheld,
        shown,
      });

      return {
        found: true,
        conversation: wrapRetrievedContent(lines, coverage),
        shown,
        scanned: disclosable.length,
        ...(hint ? { hint } : {}),
      };
    },
  });
}

function noteCoverageForHuman(
  requestContext: unknown,
  excerpts: readonly ConversationExcerpt[],
  shown: number,
): void {
  const coverage = describeCoverageForHuman(excerpts, shown);
  if (coverage) {
    writeExcerptCoverage(requestContext, coverage);
  }
}

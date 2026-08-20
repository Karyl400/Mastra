import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { logger } from '../../../../shared/logger';
import { readSlackContext, writeExcerptCoverage } from '../../../../shared/slack-request-context';
import {} from '../../../directory/domain/services/access-policy';
import type { ConversationExcerpt } from '../../domain/entities/conversation-excerpt';
import type { BotMemoryReadPort } from '../../domain/ports/bot-memory.repository';
import type {
  DirectoryPerson,
  PersonDirectoryPort,
} from '../../domain/ports/person-directory.port';
import {
  authorizeMemoryRead,
  authorizeOtherMemoryRead,
  mayDiscloseBotUtterances,
  type DisclosureReason,
  type Requester,
} from '../../domain/services/disclosure-policy';
import { describeCoverageForHuman, projectExcerpts } from '../../domain/services/excerpt-budget';
import {
  KNOWLEDGE_LOOKBACK_MS,
  KNOWLEDGE_SCAN_LIMIT,
} from '../../domain/value-objects/retrieval-window';
import { wrapRetrievedContent } from '../services/untrusted-excerpt.service';

export interface GetUserConversationsDeps {
  readonly directory: PersonDirectoryPort;
  readonly memory: BotMemoryReadPort;
}

const SLACK_USER_ID_RE = /^U[A-Z0-9]{4,}$/i;

type MemoryVerdict =
  | DisclosureReason
  | 'person_not_resolved'
  | 'person_not_found'
  | 'no_recorded_conversation'
  | 'memory_unavailable';

const VERDICT_HINTS: Partial<Record<MemoryVerdict, string>> = {
  no_requester: "Hors Slack : pas d'identité, donc rien à divulguer. Dis-le, ne réessaie pas.",
  insufficient_privilege: 'Tu ne peux montrer que les échanges de la personne qui te parle.',
  requester_denied: 'Compte non autorisé.',
  person_not_resolved: 'Demande un email ou un identifiant Slack (U…).',
  person_not_found: "Personne inconnue de l'annuaire.",
  no_recorded_conversation: "Cette personne n'a jamais échangé en direct avec toi.",
  memory_unavailable: 'Mémoire indisponible. Réessayer a un sens.',
};

function refuse(reason: MemoryVerdict) {
  const hint = VERDICT_HINTS[reason];
  return hint ? { found: false as const, reason, hint } : { found: false as const, reason };
}

async function resolveTarget(
  directory: PersonDirectoryPort,
  raw: string,
): Promise<DirectoryPerson | null | 'unparsable'> {
  const value = raw.trim();

  if (SLACK_USER_ID_RE.test(value)) return directory.findBySlackUserId(value.toUpperCase());
  if (value.includes('@')) return directory.findByEmail(value.toLowerCase());

  return 'unparsable';
}

function designatesRequester(
  asked: string,
  requesterId: string,
  requesterPerson: DirectoryPerson | null,
): boolean {
  const value = asked.trim();

  if (SLACK_USER_ID_RE.test(value)) return value.toUpperCase() === requesterId.toUpperCase();

  const ownEmail = requesterPerson?.email?.trim().toLowerCase();
  return Boolean(ownEmail) && value.toLowerCase() === ownEmail;
}

async function lookUpRequester(
  directory: { findBySlackUserId(id: string): Promise<DirectoryPerson | null> },
  requesterId: string,
): Promise<DirectoryPerson | null> {
  try {
    return await directory.findBySlackUserId(requesterId);
  } catch (error) {
    logger.warn('Knowledge — annuaire indisponible, demandeur traité comme inconnu', {
      requesterId,
      error,
    });
    return null;
  }
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

      if (resolved === 'unparsable') return refuse('person_not_resolved');

      const targetId = resolved?.slackUserId ?? (targetsRequester ? requesterId : null);
      if (!targetId) return refuse('person_not_found');

      const isSelf = targetId === requesterId;
      const dmChannelId =
        resolved?.dmChannelId ?? (isSelf && slack.channel.startsWith('D') ? slack.channel : null);

      if (!dmChannelId || !dmChannelId.startsWith('D')) {
        return refuse('no_recorded_conversation');
      }

      let turns;
      try {
        turns = await deps.memory.recentDirectTurns(dmChannelId, {
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

      if (disclosable.length === 0) return refuse('no_recorded_conversation');

      const speaker = resolved?.displayName || targetId;
      const excerpts: ConversationExcerpt[] = disclosable.map((turn) => ({
        source: 'bot_memory',
        speaker: turn.role === 'assistant' ? 'Kisso' : speaker,
        text: turn.text,
        at: turn.at,
      }));

      const { lines, shown, coverage } = projectExcerpts(excerpts);

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
  if (coverage) writeExcerptCoverage(requestContext, coverage);
}

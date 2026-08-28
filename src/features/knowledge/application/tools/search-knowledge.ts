import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { logger } from '../../../../shared/logger';
import { readSlackContext, writeExcerptCoverage } from '../../../../shared/slack-request-context';
import type { ChannelHistoryPort } from '../../domain/ports/channel-history.port';
import type { KnowledgeFactRepository } from '../../domain/ports/knowledge-fact.repository';
import type { MessageArchiveRepository } from '../../domain/ports/message-archive.repository';
import type { PersonDirectoryPort } from '../../domain/ports/person-directory.port';
import { authorizeOtherMemoryRead } from '../../domain/services/disclosure-policy';
import { FACT_KIND_LABELS } from '../../domain/services/fact-distillation';
import { wrapRetrievedContent } from '../services/untrusted-excerpt.service';
import { admit, refuse } from './search-knowledge-admission';
import {
  SCAN_LIMIT,
  describeSearchCoverage,
  readableChannels,
  resolveSpeakers,
  sweepLive,
  type Line,
} from './search-knowledge-scan';

export interface SearchKnowledgeDeps {
  readonly directory: PersonDirectoryPort;
  readonly facts: KnowledgeFactRepository;
  readonly archive: MessageArchiveRepository;
  readonly channels: ChannelHistoryPort;
}

const CHANNEL_ID_RE = /^[CG][A-Z0-9]{4,}$/i;

const MAX_RESULTS = 6;

function stamp(postedAt: number): string {
  return new Date(postedAt).toISOString().slice(0, 10);
}

export function makeSearchKnowledge(deps: SearchKnowledgeDeps) {
  return createTool({
    id: 'searchKnowledge',
    description:
      'Cherche dans ta base ce qui a été dit dans les canaux : décisions, engagements, blocages, échéances.',
    inputSchema: z.object({
      query: z.string().trim().min(2).max(200).describe('Les mots à chercher.'),
      channelId: z
        .string()
        .trim()
        .regex(CHANNEL_ID_RE)
        .optional()
        .describe('Restreint à un canal (C… ou G…).'),
      person: z
        .string()
        .trim()
        .max(254)
        .optional()
        .describe('Email ou identifiant Slack. Réservé au manager pour quelqu’un d’autre.'),
    }),
    execute: async (data, ctx) => {
      const slack = readSlackContext(ctx?.requestContext);
      if (!slack?.slackUserId) {
        logger.warn('Knowledge — recherche refusée : aucun demandeur identifié', {
          scope: 'knowledge_base',
        });
        return refuse('no_requester');
      }

      const requesterId = slack.slackUserId;
      const admission = await admit(deps.directory, requesterId, data.person);
      if ('reason' in admission) return refuse(admission.reason);

      const { requester, target } = admission;

      const scope = {
        channelId: data.channelId?.toUpperCase(),
        slackUserId: target ?? undefined,
        limit: SCAN_LIMIT,
      };

      let lines: Line[];
      let tier: 'facts' | 'messages' | 'live';
      try {
        const facts = await deps.facts.search(data.query, scope);

        if (facts.length > 0) {
          tier = 'facts';
          lines = facts.map((fact) => ({
            channelId: fact.channelId,
            slackUserId: fact.slackUserId,
            postedAt: fact.postedAt,
            kind: fact.kind,
            text: fact.summary,
          }));
        } else {
          tier = 'messages';
          const messages = await deps.archive.search(data.query, scope);
          lines = messages.map((message) => ({
            channelId: message.channelId,
            slackUserId: message.slackUserId,
            postedAt: message.postedAt,
            kind: null,
            text: message.text,
          }));
        }
      } catch (error) {
        logger.error('Knowledge — lecture de la base en échec', { requesterId, error });
        return refuse('knowledge_unavailable');
      }

      if (lines.length === 0) {
        lines = await sweepLive(deps.channels, data.query, requesterId, scope.channelId);
        tier = 'live';
        if (lines.length === 0) return refuse('nothing_known');
      }

      const allowed = await readableChannels(
        deps.channels,
        lines.map((line) => line.channelId),
        requesterId,
        authorizeOtherMemoryRead(requester).allowed,
      );

      const visible = lines.filter((line) => allowed.has(line.channelId));
      if (visible.length === 0) return refuse('no_readable_channel');

      const shown = visible.slice(0, MAX_RESULTS);
      const speakers = await resolveSpeakers(deps.directory, shown);

      const rendered = shown
        .map((line) => {
          const who = line.slackUserId ? (speakers.get(line.slackUserId) ?? line.slackUserId) : '?';
          const label = line.kind ? `${FACT_KIND_LABELS[line.kind]} — ` : '';
          return `[${stamp(line.postedAt)}] ${who}: ${label}${line.text}`;
        })
        .join('\n');

      const coverage = describeSearchCoverage(shown.length, visible.length, tier);

      writeExcerptCoverage(
        ctx?.requestContext,
        `_${shown.length} élément(s) retrouvé(s) dans ma base, pas une lecture exhaustive du canal._`,
      );

      logger.info('Knowledge — recherche en base', {
        scope: 'knowledge_base',
        requesterId,
        tier,
        matched: lines.length,
        visible: visible.length,
        shown: shown.length,
        nominative: Boolean(target),
      });

      return {
        found: true,
        tier,
        shown: shown.length,
        knowledge: wrapRetrievedContent(rendered, coverage),
      };
    },
  });
}

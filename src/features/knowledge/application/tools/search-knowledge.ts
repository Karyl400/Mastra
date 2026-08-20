import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { logger } from '../../../../shared/logger';
import { readSlackContext, writeExcerptCoverage } from '../../../../shared/slack-request-context';
import type { ChannelHistoryPort } from '../../domain/ports/channel-history.port';
import type { KnowledgeFactRepository } from '../../domain/ports/knowledge-fact.repository';
import type { MessageArchiveRepository } from '../../domain/ports/message-archive.repository';
import type {
  DirectoryPerson,
  PersonDirectoryPort,
} from '../../domain/ports/person-directory.port';
import {
  authorizeMemoryRead,
  authorizeOtherMemoryRead,
  type DisclosureReason,
  type Requester,
} from '../../domain/services/disclosure-policy';
import { FACT_KIND_LABELS, type FactKind } from '../../domain/services/fact-distillation';
import { wrapRetrievedContent } from '../services/untrusted-excerpt.service';

export interface SearchKnowledgeDeps {
  readonly directory: PersonDirectoryPort;
  readonly facts: KnowledgeFactRepository;
  readonly archive: MessageArchiveRepository;
  readonly channels: ChannelHistoryPort;
}

const SLACK_USER_ID_RE = /^U[A-Z0-9]{4,}$/i;

const CHANNEL_ID_RE = /^[CG][A-Z0-9]{4,}$/i;

const MAX_RESULTS = 6;

const MAX_CHANNELS_CHECKED = 6;

const SCAN_LIMIT = 24;

type SearchVerdict =
  | DisclosureReason
  | 'person_not_resolved'
  | 'person_not_found'
  | 'nothing_known'
  | 'no_readable_channel'
  | 'knowledge_unavailable';

const VERDICT_HINTS: Partial<Record<SearchVerdict, string>> = {
  no_requester: "Hors Slack : pas d'identité, donc rien à divulguer. Dis-le, ne réessaie pas.",
  insufficient_privilege:
    "Seul le manager peut chercher ce qu'une AUTRE personne a dit. Dis-le, et propose de chercher sans nommer personne.",
  requester_denied: 'Compte non autorisé.',
  person_not_resolved: 'Donne un email ou un identifiant Slack (U…), pas un prénom.',
  person_not_found: "Personne inconnue de l'annuaire.",
  nothing_known:
    'Rien en base sur ce sujet. Si un canal précis est en jeu, `getChannelHistory` peut le lire en direct — sinon dis simplement que tu ne sais pas.',
  no_readable_channel: "Ce que je sais vient de canaux dont tu n'es pas membre. Je n'en dis rien.",
  knowledge_unavailable: 'Base de connaissance indisponible. Réessayer a un sens.',
};

function refuse(reason: SearchVerdict) {
  const hint = VERDICT_HINTS[reason];
  return hint ? { found: false as const, reason, hint } : { found: false as const, reason };
}

interface Line {
  readonly channelId: string;
  readonly slackUserId: string | null;
  readonly postedAt: number;
  readonly kind: FactKind | null;
  readonly text: string;
}

function stamp(postedAt: number): string {
  return new Date(postedAt).toISOString().slice(0, 10);
}

export function makeSearchKnowledge(deps: SearchKnowledgeDeps) {
  /** Une lecture par personne et par canal distincts, jamais une par ligne. */
  async function resolveSpeakers(lines: readonly Line[]): Promise<Map<string, string>> {
    const ids = [...new Set(lines.map((l) => l.slackUserId).filter((id): id is string => !!id))];

    const resolved = await Promise.all(
      ids.map(async (id) => {
        try {
          const person = await deps.directory.findBySlackUserId(id);
          return [id, person?.displayName?.trim() || id] as const;
        } catch {
          return [id, id] as const;
        }
      }),
    );

    return new Map(resolved);
  }

  /**
   * ⚠️ LA FRONTIÈRE QUI COMPTE. L'archive contient les canaux PRIVÉS où le bot est invité.
   * Sans ce filtre, une recherche rendrait le contenu de `#engineer-karyl` à quelqu'un qui
   * n'y est pas — ce que `getChannelHistory` refuse déjà en lecture directe. L'appartenance
   * est tranchée en direct auprès de Slack, jamais sur l'inventaire local qu'aucun événement
   * ne vient démentir.
   */
  async function readableChannels(
    channelIds: readonly string[],
    requesterId: string,
  ): Promise<Set<string>> {
    const distinct = [...new Set(channelIds)].slice(0, MAX_CHANNELS_CHECKED);

    const verdicts = await Promise.all(
      distinct.map(async (channelId) => {
        try {
          return [channelId, await deps.channels.isMember(channelId, requesterId)] as const;
        } catch (error) {
          logger.warn('Knowledge — appartenance indécidable, canal écarté de la recherche', {
            channelId,
            error,
          });
          return [channelId, false] as const;
        }
      }),
    );

    return new Set(verdicts.filter(([, member]) => member).map(([channelId]) => channelId));
  }

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

      const nominative = classifyPerson(data.person, requesterId, requesterPerson);
      if (nominative.kind === 'unparsable') return refuse('person_not_resolved');

      // ⚠️ LE VERDICT TOMBE AVANT TOUTE LECTURE, et c'est ce qui empêche l'ORACLE : sans cela,
      // « personne inconnue » et « tu n'as pas le droit » se distinguent, et l'annuaire
      // s'énumère une adresse à la fois. Même règle que le chemin email de `getEmployeeProfile`.
      if (nominative.kind === 'other') {
        const verdict = authorizeOtherMemoryRead(requester);
        if (!verdict.allowed) {
          logger.warn('Knowledge — recherche nominative refusée', {
            scope: 'knowledge_base',
            requesterId,
            reason: verdict.reason,
          });
          return refuse(verdict.reason);
        }
      }

      if (nominative.kind === 'self') {
        const verdict = authorizeMemoryRead(requester, requesterId);
        if (!verdict.allowed) return refuse(verdict.reason);
      }

      const target = await resolveTarget(deps.directory, nominative);
      if (target === 'not_found') return refuse('person_not_found');

      const scope = {
        channelId: data.channelId?.toUpperCase(),
        slackUserId: target ?? undefined,
        limit: SCAN_LIMIT,
      };

      let lines: Line[];
      let tier: 'facts' | 'messages';
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

      if (lines.length === 0) return refuse('nothing_known');

      const allowed = await readableChannels(
        lines.map((line) => line.channelId),
        requesterId,
      );

      const visible = lines.filter((line) => allowed.has(line.channelId));
      if (visible.length === 0) return refuse('no_readable_channel');

      const shown = visible.slice(0, MAX_RESULTS);
      const speakers = await resolveSpeakers(shown);

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

function describeSearchCoverage(shown: number, matched: number, tier: string): string {
  const source =
    tier === 'facts'
      ? "Ces éléments viennent de ce que j'ai retenu au fil des canaux"
      : "Ces éléments sont des messages bruts d'archive";

  const truncation = matched > shown ? ` sur ${matched} correspondances` : '';

  return `${source}${truncation} — PAS une lecture exhaustive. Ne conclus pas que rien d'autre n'a été dit.`;
}

type Nominative =
  | { readonly kind: 'none' }
  | { readonly kind: 'unparsable' }
  | { readonly kind: 'self'; readonly slackUserId: string }
  | { readonly kind: 'other'; readonly slackUserId?: string; readonly email?: string };

/** Purement syntaxique : AUCUNE lecture, donc aucune information rendue avant le verdict. */
function classifyPerson(
  raw: string | undefined,
  requesterId: string,
  requesterPerson: DirectoryPerson | null,
): Nominative {
  const value = raw?.trim();
  if (!value) return { kind: 'none' };

  if (SLACK_USER_ID_RE.test(value)) {
    const slackUserId = value.toUpperCase();
    return slackUserId === requesterId.toUpperCase()
      ? { kind: 'self', slackUserId: requesterId }
      : { kind: 'other', slackUserId };
  }

  if (!value.includes('@')) return { kind: 'unparsable' };

  const email = value.toLowerCase();
  const ownEmail = requesterPerson?.email?.trim().toLowerCase();

  return ownEmail && email === ownEmail
    ? { kind: 'self', slackUserId: requesterId }
    : { kind: 'other', email };
}

async function resolveTarget(
  directory: PersonDirectoryPort,
  nominative: Nominative,
): Promise<string | null | 'not_found'> {
  if (nominative.kind === 'none' || nominative.kind === 'unparsable') return null;
  if (nominative.kind === 'self') return nominative.slackUserId;

  if (nominative.slackUserId) return nominative.slackUserId;

  const person = await directory.findByEmail(nominative.email!);
  return person?.slackUserId ?? 'not_found';
}

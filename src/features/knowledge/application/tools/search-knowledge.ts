import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { logger } from '../../../../shared/logger';
import { readSlackContext, writeExcerptCoverage } from '../../../../shared/slack-request-context';
import type { ChannelHistoryPort } from '../../domain/ports/channel-history.port';
import type { KnowledgeFactRepository } from '../../domain/ports/knowledge-fact.repository';
import {
  isDirectMessageChannel,
  type MessageArchiveRepository,
} from '../../domain/ports/message-archive.repository';
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
import { matchedTermCount } from '../../domain/services/text-search';
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

/** Bornes de la lecture EN DIRECT — elle ne doit jamais devenir un balayage du workspace. */
const LIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const LIVE_SCAN_LIMIT = 60;

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
    isManager: boolean,
  ): Promise<Set<string>> {
    const distinct = [...new Set(channelIds)].slice(0, MAX_CHANNELS_CHECKED);

    const verdicts = await Promise.all(
      distinct.map(async (channelId) => {
        /**
         * ⚠️ **UN DM NE SE TRANCHE PAS PAR L'APPARTENANCE — ajouté le 2026-08-21 avec
         * l'archivage des DM.**
         *
         * `conversations.members` sur un `D…` rendrait « membre » pour ses deux participants et
         * « non-membre » pour tout le monde d'autre, manager compris : la ligne serait donc
         * filtrée juste après qu'`authorizeOtherMemoryRead` l'ait autorisée. La recherche
         * nominative du manager marcherait sur les canaux et échouerait en silence sur les DM,
         * sans jamais dire pourquoi — deux frontières qui se contredisent, et c'est la seconde
         * qui gagne sans le dire.
         *
         * La règle est donc explicite : son propre DM toujours, celui d'autrui au niveau
         * `full`. La MÊME règle que `mayTouchRecord`, écrite ici parce que le sujet n'est pas
         * un dossier mais un canal.
         */
        if (isDirectMessageChannel(channelId)) {
          const own = await deps.channels
            .isMember(channelId, requesterId)
            .catch(() => false as boolean);
          return [channelId, own || isManager] as const;
        }

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

  /**
   * ════════════════════════════════════════════════════════════════════════
   * LE REPLI EN DIRECT — lire Slack AVANT de prétendre ne rien savoir
   * ════════════════════════════════════════════════════════════════════════
   *
   * Jusqu'au 2026-08-21, une base vide rendait `nothing_known` avec un `hint` invitant le
   * modèle à appeler `getChannelHistory` lui-même. C'était une CONSIGNE — et ce dépôt a mesuré
   * cinq consignes en échec. Pire : les deux niveaux de la base étaient EMPTY en production
   * (`channel_messages` et `knowledge_facts`, 0 ligne), donc `nothing_known` était la seule
   * réponse que cet outil savait rendre, et rien ne le signalait.
   *
   * ⚠️ **LA FRONTIÈRE EST TENUE PAR LA CONSTRUCTION DE LA LISTE, pas par un filtre.** On part
   * des canaux dont le DEMANDEUR est membre (`listMemberChannels`) : il n'y a donc rien à
   * filtrer ensuite, donc rien à oublier de filtrer. C'est la différence entre une garantie et
   * une vérification.
   *
   * ⚠️ **CE CHEMIN NE COÛTE QUE SUR UN ÉCHEC**, comme `settlesWithoutModel` qui ne vit
   * qu'après un refus : le chemin nominal — la base répond — ne paie rien. Et il est borné
   * des deux côtés (nombre de canaux, fenêtre, nombre de lignes rendues) : une recherche large
   * ne doit pas pouvoir devenir un balayage complet du workspace.
   *
   * ⚠️ Il ne LÈVE jamais : un canal illisible est sauté. Le pire cas reste « je ne sais pas »,
   * qui est exactement la réponse qu'on avait avant.
   */
  async function sweepLive(query: string, requesterId: string, only?: string): Promise<Line[]> {
    const channelIds = only
      ? [only]
      : await deps.channels.listMemberChannels(requesterId, MAX_CHANNELS_CHECKED);

    if (channelIds.length === 0) return [];

    // Un canal explicitement demandé n'échappe PAS au contrôle d'appartenance : c'est le
    // modèle qui l'a écrit, donc une valeur réputée contrôlée par un attaquant.
    const readable = only ? await readableChannels([only], requesterId, false) : null;
    const targets = readable ? channelIds.filter((id) => readable.has(id)) : channelIds;

    const perChannel = await Promise.all(
      targets.map((channelId) => sweepOneChannel(channelId, query)),
    );

    return perChannel
      .flat()
      .sort((a, b) => b.postedAt - a.postedAt)
      .slice(0, SCAN_LIMIT);
  }

  /** Un canal illisible est SAUTÉ : le pire cas reste « je ne sais pas ». */
  async function sweepOneChannel(channelId: string, query: string): Promise<Line[]> {
    try {
      const messages = await deps.channels.fetchRecent(channelId, {
        sinceMs: LIVE_WINDOW_MS,
        limit: LIVE_SCAN_LIMIT,
      });

      return messages
        .filter((message) => !message.isBot && matchedTermCount(message.text, query) > 0)
        .map<Line>((message) => ({
          channelId,
          slackUserId: message.authorId,
          postedAt: message.at.getTime(),
          kind: null,
          text: message.text,
        }));
    } catch (error) {
      logger.warn('Knowledge — canal illisible pendant la lecture en direct', {
        channelId,
        error: String(error),
      });
      return [];
    }
  }

  /**
   * ⚠️ **LE VERDICT TOMBE AVANT TOUTE LECTURE, et c'est ce qui empêche l'ORACLE** : sans cela,
   * « personne inconnue » et « tu n'as pas le droit » se distinguent, et l'annuaire s'énumère
   * une adresse à la fois. Même règle que le chemin email de `getEmployeeProfile`.
   *
   * Extrait d'`execute` le 2026-08-21 — non pour le chiffre de complexité, mais parce que cette
   * séquence EST la frontière : la voir d'un bloc vaut mieux que la lire entre deux lectures de
   * base.
   */
  async function admit(
    requesterId: string,
    person: string | undefined,
  ): Promise<{ requester: Requester; target: string | null } | { reason: SearchVerdict }> {
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

    const nominative = classifyPerson(person, requesterId, requesterPerson);
    if (nominative.kind === 'unparsable') return { reason: 'person_not_resolved' };

    if (nominative.kind === 'other') {
      const verdict = authorizeOtherMemoryRead(requester);
      if (!verdict.allowed) {
        logger.warn('Knowledge — recherche nominative refusée', {
          scope: 'knowledge_base',
          requesterId,
          reason: verdict.reason,
        });
        return { reason: verdict.reason };
      }
    }

    if (nominative.kind === 'self') {
      const verdict = authorizeMemoryRead(requester, requesterId);
      if (!verdict.allowed) return { reason: verdict.reason };
    }

    const target = await resolveTarget(deps.directory, nominative);
    if (target === 'not_found') return { reason: 'person_not_found' };

    return { requester, target };
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
      const admission = await admit(requesterId, data.person);
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

      // ⚠️ On LIT SLACK avant de dire qu'on ne sait pas. La base peut être vide pour deux
      // raisons très différentes — le sujet n'a jamais été évoqué, ou l'archivage n'a rien
      // capté — et « je ne sais pas » les confond. En production, les deux niveaux étaient
      // vides : cet outil ne pouvait RIEN rendre d'autre, et personne ne le voyait.
      if (lines.length === 0) {
        lines = await sweepLive(data.query, requesterId, scope.channelId);
        tier = 'live';
        if (lines.length === 0) return refuse('nothing_known');
      }

      const allowed = await readableChannels(
        lines.map((line) => line.channelId),
        requesterId,
        authorizeOtherMemoryRead(requester).allowed,
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

const COVERAGE_SOURCES: Readonly<Record<string, string>> = {
  facts: "Ces éléments viennent de ce que j'ai retenu au fil des canaux",
  messages: "Ces éléments sont des messages bruts d'archive",
  live: 'Ces éléments viennent de canaux que je viens de relire à l’instant, sur le dernier mois',
};

function describeSearchCoverage(shown: number, matched: number, tier: string): string {
  // ⚠️ La provenance est DITE, et elle change ce que la personne doit en conclure : une lecture
  // en direct ne voit que la fenêtre récente, une archive ne voit que ce qui a été capté.
  const source = COVERAGE_SOURCES[tier] ?? COVERAGE_SOURCES.messages;

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

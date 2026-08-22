import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WebClient } from '@slack/web-api';
import type { Mastra } from '@mastra/core';

import {
  SlackEventsHandler,
  type SlackEventsHandlerOptions,
  type SlackEventEnvelope,
} from '../../../src/features/notification/infrastructure/handlers/slack-events.handler';
import { InMemorySlackEventDedupRepository } from '../../../src/features/notification/infrastructure/repositories/in-memory-slack-event-dedup.repository';
import { InMemoryPendingInterviewEmailRepository } from '../../../src/features/recruitment/infrastructure/repositories/in-memory-pending-email.repository';
import { SlackRateLimiter } from '../../../src/features/notification/infrastructure/services/slack-rate-limiter';
import type { RateLimitRepository } from '../../../src/features/notification/domain/ports/rate-limit.repository';
import {
  BURST_RULE,
  DAILY_RULE,
} from '../../../src/features/notification/domain/services/rate-limit-policy';
import { PROFILE_QUESTIONS } from '../../../src/features/onboarding/domain/services/profile-chat';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LE QUOTA NE DOIT JAMAIS REFUSER UN GESTE QUI NE COÛTE RIEN
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Troisième occurrence de la même famille dans ce dépôt, et c'est la raison d'être de ce
 * fichier :
 *
 *   • 2026-08-13 — « bonjour » recevait « J'ai atteint mon quota » ;
 *   • 2026-08-19 — `profile_done` manquait au miroir, donc « j'ai fini » était FACTURÉ ;
 *   • 2026-08-20 — les deux court-circuits dont la reconnaissance dépend d'un ÉTAT étaient
 *     structurellement invisibles au miroir textuel, qui ne peut rien lire sur le chemin de
 *     l'ACK. Une personne au quota ne pouvait donc pas ANNULER un email d'entretien en
 *     attente, ni terminer son propre dossier.
 *
 * Ce que ces tests verrouillent est une INÉGALITÉ, pas un mécanisme : ce qui ne consomme pas
 * de tokens n'est jamais refusé par un compteur de tokens — et, symétriquement, la levée ne
 * doit couvrir NI la rafale (un abus reste un abus) NI un message qui partirait chez un agent.
 */

const HUMAN = 'U0BJBDGTJUD';
const DM = 'D0MOCKDM01';
const CANDIDATE = 'jean@exemple.com';

function futureIso(): string {
  return new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Compteur partagé en mémoire : le nombre rendu décide, exactement comme la Turso.
 *
 * ⚠️ Il répond PAR RÈGLE — la clé porte son nom. Un compteur uniforme saturerait aussi la
 * RAFALE, et c'est alors elle qui refuserait : le test croirait mesurer le budget quotidien
 * alors qu'il mesurerait l'anti-abus, dont la levée n'est justement pas la même.
 */
function countingRepository(counts: Readonly<Record<string, number>>): RateLimitRepository {
  return {
    increment: vi.fn(async (key: string) => counts[key.split(':')[0] ?? ''] ?? 0),
    pruneOlderThan: vi.fn(async () => 0),
  } as unknown as RateLimitRepository;
}

function makeHandler(options?: {
  seedPending?: boolean;
  lastAssistant?: string;
  counts?: Readonly<Record<string, number>>;
}) {
  const slack = {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1700000000.000900' }),
      update: vi.fn().mockResolvedValue({ ok: true }),
    },
    auth: { test: vi.fn().mockResolvedValue({ user_id: 'U0BMBEJTBMJ' }) },
  };

  const pending = new InMemoryPendingInterviewEmailRepository();
  if (options?.seedPending !== false) {
    void pending.save({
      conversationId: DM,
      requesterUserId: HUMAN,
      to: CANDIDATE,
      candidateName: 'Jean DUPONT',
      startsAt: futureIso(),
      position: 'Backend Developer',
      location: null,
      replyTo: null,
      createdAt: new Date(),
    });
  }

  const limiter = new SlackRateLimiter({
    rules: [BURST_RULE, DAILY_RULE],
    // Budget quotidien saturé : la lecture rend déjà la limite, donc la projection `+1`
    // refuse. La rafale, elle, reste à zéro sauf mention contraire.
    repository: countingRepository(options?.counts ?? { daily: DAILY_RULE.limit }),
    workspaceRule: null,
  });

  const conversationRepository = {
    append: vi.fn(async (turn: unknown) => turn),
    recentTurns: vi.fn(async () =>
      options?.lastAssistant
        ? [
            {
              id: '1',
              conversationId: DM,
              role: 'assistant',
              content: options.lastAssistant,
              agentId: 'onboardingOrchestrator',
              slackUserId: null,
              createdAt: new Date(),
            },
          ]
        : [],
    ),
    pruneOlderThan: vi.fn(async () => 0),
    forget: vi.fn(async () => 0),
  };

  const handler = new SlackEventsHandler(
    'xoxb-test-token',
    {
      getAgent: vi.fn(() => {
        throw new Error('Le modèle ne doit JAMAIS être appelé sur ce chemin');
      }),
    } as unknown as Mastra,
    {
      slackClient: slack as unknown as WebClient,
      chatProvider: {
        sendBlocks: vi.fn().mockResolvedValue({ ts: '1' }),
      } as unknown as SlackEventsHandlerOptions['chatProvider'],
      accessGuard: null,
      workspaceProvider: { getUserById: async () => null },
      auditSink: async () => undefined,
      conversationRepository:
        conversationRepository as unknown as SlackEventsHandlerOptions['conversationRepository'],
      dedupRepository: new InMemorySlackEventDedupRepository(),
      rateLimiter: limiter,
      pinnedFactRepository: null,
      directoryRepository: {
        findBySlackUserId: vi.fn(async (id: string) => ({
          slackUserId: id,
          realName: 'Karyl SOUMAILA',
          displayName: 'Karyl SOUMAILA',
          firstName: 'Karyl',
          lastName: 'SOUMAILA',
          email: 'karyl@kisso.com',
          employeeId: null,
        })),
        rememberDmChannel: vi.fn(async () => undefined),
        upsertFacts: vi.fn(async () => undefined),
        linkEmployee: vi.fn(async () => 1),
      } as unknown as SlackEventsHandlerOptions['directoryRepository'],
      pendingEmailRepository: pending,
      sendEmail: vi.fn(async () => ({ ok: true })),
      pruneProbability: 0,
    },
  );

  return { handler, slack, pending };
}

function envelope(text: string, ts = '1700000000.000200'): SlackEventEnvelope {
  return {
    type: 'event_callback',
    event_id: `Ev${ts}`,
    event_time: Math.floor(Date.now() / 1000),
    event: { type: 'message', user: HUMAN, text, channel: DM, channel_type: 'im', ts },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('au quota, ce qui ne coûte rien passe quand même', () => {
  it('« non » sur un email en attente est ACCEPTÉ malgré le budget épuisé', async () => {
    const { handler } = makeHandler();

    const decision = await handler.accept(envelope('non'));

    expect(decision.action).toBe('process');
  });

  it('« oui » sur un email en attente est ACCEPTÉ malgré le budget épuisé', async () => {
    const { handler } = makeHandler();

    const decision = await handler.accept(envelope('oui'));

    expect(decision.action).toBe('process');
  });

  it('une réponse à une question du dossier est ACCEPTÉE malgré le budget épuisé', async () => {
    const { handler } = makeHandler({
      seedPending: false,
      lastAssistant: PROFILE_QUESTIONS.firstName,
    });

    const decision = await handler.accept(envelope('Karyl SOUMAILA'));

    expect(decision.action).toBe('process');
  });
});

describe('la levée ne déborde pas', () => {
  it('un message ORDINAIRE reste refusé — c’est lui qui coûte des tokens', async () => {
    const { handler } = makeHandler({ seedPending: false });

    const decision = await handler.accept(envelope('génère-moi le guide en PDF'));

    expect(decision).toEqual({ action: 'ignore', reason: 'rate_limited' });
  });

  it('un « oui » SANS rien en attente reste refusé', async () => {
    const { handler } = makeHandler({ seedPending: false });

    const decision = await handler.accept(envelope('oui'));

    expect(decision).toEqual({ action: 'ignore', reason: 'rate_limited' });
  });

  it('une RAFALE refuse même un « non » qui trancherait l’email', async () => {
    // La règle de rafale ne rationne pas le budget du modèle : elle contre un abus, et un
    // abus reste un abus. Attendre douze secondes n'a jamais empêché personne d'annuler.
    const { handler } = makeHandler({ counts: { burst: BURST_RULE.limit + 1 } });

    const decision = await handler.accept(envelope('non'));

    expect(decision).toEqual({ action: 'ignore', reason: 'rate_limited' });
  });

  it('une question POSÉE AU BOT pendant le dossier reste refusée', async () => {
    // `answersOnboardingQuestion` écarte les questions : elles partent chez un agent, donc
    // elles coûtent. Le miroir doit refuser exactement ce que le handler facturera.
    const { handler } = makeHandler({
      seedPending: false,
      lastAssistant: PROFILE_QUESTIONS.firstName,
    });

    const decision = await handler.accept(envelope('qui s’occupe du support technique ?'));

    expect(decision).toEqual({ action: 'ignore', reason: 'rate_limited' });
  });
});

describe('la limitation ne devient pas son propre spam', () => {
  it('ne prévient QU’UNE FOIS par fenêtre, même quand le compteur ne bouge plus', async () => {
    // Sous RÉSERVATION le compteur n'est pas incrémenté : `count === limit + 1` reste vrai à
    // chaque message, et l'avertissement partait à chaque fois.
    const { handler, slack } = makeHandler({ seedPending: false });

    await handler.accept(envelope('première demande', '1700000000.000200'));
    await handler.accept(envelope('deuxième demande', '1700000000.000300'));
    await handler.accept(envelope('troisième demande', '1700000000.000400'));

    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
  });
});

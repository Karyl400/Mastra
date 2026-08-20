import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WebClient } from '@slack/web-api';
import type { Mastra } from '@mastra/core';

import {
  SlackEventsHandler,
  type SlackEventsHandlerOptions,
  type SlackMessageEvent,
} from '../../../src/features/notification/infrastructure/handlers/slack-events.handler';
import { InMemorySlackEventDedupRepository } from '../../../src/features/notification/infrastructure/repositories/in-memory-slack-event-dedup.repository';
import { PROFILE_QUESTIONS } from '../../../src/features/onboarding/domain/services/profile-chat';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * « IL CHANGE DE SUJET » — on lui répond, ET on ne lâche pas son dossier
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Le rappel a ses propres tests. Ceux-ci vérifient le CÂBLAGE : qu'il est bien accolé à la
 * réponse de l'agent, dans le MÊME message, et seulement quand une question attend vraiment.
 *
 * ⚠️ Le point délicat est un ORDRE : répondre remplace le dernier tour `assistant`, qui EST
 * l'état de la machine à états. L'état doit donc être relevé AVANT que l'accueil ne consomme
 * le tour — sinon le rappel ne part jamais, et rien ne le signale.
 */

const HUMAN = 'U0BJBDGTJUD';
const DM = 'D0MOCKDM01';

function makeHandler(options: { lastAssistant?: string; agentText: string }) {
  const slack = {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1700000000.000900' }),
      update: vi.fn().mockResolvedValue({ ok: true }),
    },
    auth: { test: vi.fn().mockResolvedValue({ user_id: 'U0BMBEJTBMJ' }) },
  };

  const conversationRepository = {
    append: vi.fn(async (turn: unknown) => turn),
    recentTurns: vi.fn(async () =>
      options.lastAssistant
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
    prune: vi.fn(async () => 0),
    forget: vi.fn(async () => 0),
  };

  const handler = new SlackEventsHandler(
    'xoxb-test-token',
    {
      getAgent: vi.fn(() => ({ generate: async () => ({ text: options.agentText }) })),
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
      rateLimiter: null,
      pinnedFactRepository: null,
      directoryRepository: {
        findBySlackUserId: vi.fn(async (id: string) => ({
          slackUserId: id,
          realName: 'Karyl SOUMAILA',
          displayName: 'Karyl SOUMAILA',
          firstName: 'Karyl',
          lastName: 'SOUMAILA',
          email: 'karyl@kissohq.com',
          employeeId: null,
          isManager: false,
        })),
        rememberDmChannel: vi.fn(async () => undefined),
        upsertFacts: vi.fn(async () => undefined),
        linkEmployee: vi.fn(async () => 1),
        findManagers: vi.fn(async () => []),
      } as unknown as SlackEventsHandlerOptions['directoryRepository'],
      pruneProbability: 0,
    },
  );

  return { handler, slack };
}

const dm = (text: string, ts = '1700000000.000200'): SlackMessageEvent => ({
  type: 'message',
  user: HUMAN,
  text,
  channel: DM,
  channel_type: 'im',
  ts,
});

/** Le texte réellement publié — `chat.update` quand le marqueur a été posé, sinon le post. */
function published(slack: {
  chat: { postMessage: { mock: { calls: unknown[][] } }; update: { mock: { calls: unknown[][] } } };
}): string {
  const updates = slack.chat.update.mock.calls.map((c) =>
    String((c[0] as { text?: string })?.text),
  );
  if (updates.length > 0) return updates[updates.length - 1]!;
  const posts = slack.chat.postMessage.mock.calls.map((c) =>
    String((c[0] as { text?: string })?.text),
  );
  return posts[posts.length - 1] ?? '';
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('le dossier laissé en plan revient, accolé à la réponse', () => {
  it('répond au nouveau sujet ET rappelle ce qui manque — en UN seul message', async () => {
    // Deux messages feraient paraître le bot bavard là où il ne fait que ne pas oublier, et un
    // rappel posté seul se lit comme un reproche.
    const { handler, slack } = makeHandler({
      lastAssistant: PROFILE_QUESTIONS.lastName,
      agentText: 'Pamela s’occupe du produit.',
    });

    await handler.handleMessage(dm('qui s’occupe du produit ?'));

    const text = published(slack);
    expect(text).toContain('Pamela s’occupe du produit.');
    expect(text).toContain('ton nom de famille');
  });

  it('ne rappelle RIEN quand aucune question n’attend', async () => {
    const { handler, slack } = makeHandler({
      lastAssistant: 'Voici ton guide.',
      agentText: 'Pamela s’occupe du produit.',
    });

    await handler.handleMessage(dm('qui s’occupe du produit ?'));

    expect(published(slack)).toBe('Pamela s’occupe du produit.');
  });

  it('ne rappelle RIEN quand la personne RÉPOND à la question', async () => {
    // Le message est alors traité par la machine à états, sans modèle : il n'y a pas de
    // réponse d'agent à laquelle accoler quoi que ce soit, et surtout plus rien à rappeler.
    const { handler, slack } = makeHandler({
      lastAssistant: PROFILE_QUESTIONS.lastName,
      agentText: 'ne doit pas être appelé',
    });

    await handler.handleMessage(dm('TRAORE'));

    expect(published(slack)).not.toContain('il me manque');
  });
});

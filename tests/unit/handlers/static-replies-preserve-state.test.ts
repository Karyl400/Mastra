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
import { INTERVIEW_QUESTION_DAILY } from '../../../src/features/onboarding/domain/services/interview-chat';
import { DISTRESS_REPLY } from '../../../src/shared/distress';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * Les court-circuits STATIQUES détruisaient l'état des machines à états
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Le correctif du 2026-08-19 a fait céder le pas aux court-circuits AGISSANTS (effacement,
 * épinglage, formulaire) : `maybeRunProfileStep` et `maybeRunInterviewStep` sortent quand
 * `findActingReply` reconnaît le message. Le groupe STATIQUE, lui, n'a pas été traité — et il
 * tourne AVANT (`findStaticReply` ligne 2467, `maybeAdvanceOnboarding` ligne 2540).
 *
 * L'état des deux machines EST le dernier tour `assistant` du fil. Une réponse figée
 * mémorisée l'ÉCRASE, définitivement : la question en attente devient invisible, et le message
 * suivant part chez un agent qui n'a rien demandé.
 *
 * Deux cas mesurés sur les modules réels :
 *   • « Salut » ou « Test » comme PRÉNOM → `bare_greeting`, seul court-circuit à
 *     `remembersTurn: true`. L'état est détruit.
 *   • « Chargée de mission harcèlement et discrimination » comme INTITULÉ DE POSTE →
 *     `distress`. Dans un bot RH, c'est un intitulé réel.
 *
 * ⚠️ ARBITRAGE : la détresse GARDE la priorité, et ce n'est pas négociable. L'asymétrie est
 * claire — un faux positif donne un numéro d'aide à quelqu'un qui parlait de son métier
 * (gênant) ; un faux négatif enregistre « je ne vais pas bien » comme un nom de famille et
 * n'aide personne (dangereux). Ce qui est corrigé n'est donc pas l'ORDRE, c'est la
 * DESTRUCTION D'ÉTAT : la réponse figée est postée, et le fil reste exactement où il était.
 */

const HUMAN = 'U0BJBDGTJUD';
const DM = 'D0MOCKDM01';

function makeHandler(lastAssistant: string) {
  const slack = {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1700000000.000900' }),
      update: vi.fn().mockResolvedValue({ ok: true }),
    },
    auth: { test: vi.fn().mockResolvedValue({ user_id: 'U0BMBEJTBMJ' }) },
  };

  const append = vi.fn(async (turn: unknown) => turn);
  const conversationRepository = {
    append,
    recentTurns: vi.fn(async () => [
      {
        id: '1',
        conversationId: DM,
        role: 'assistant',
        content: lastAssistant,
        agentId: 'onboardingOrchestrator',
        slackUserId: null,
        createdAt: new Date(),
      },
    ]),
    prune: vi.fn(async () => 0),
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
      rateLimiter: null,
      pinnedFactRepository: null,
      directoryRepository: {
        findBySlackUserId: vi.fn(async () => ({
          slackUserId: HUMAN,
          realName: 'Karyl SOUMAILA',
          displayName: 'Karyl SOUMAILA',
          firstName: 'Karyl',
          lastName: 'SOUMAILA',
          email: 'karyl@kisso.com',
          employeeId: null,
        })),
        rememberDmChannel: vi.fn(async () => undefined),
        upsertFacts: vi.fn(async () => undefined),
        linkEmployee: vi.fn(async () => undefined),
      } as unknown as SlackEventsHandlerOptions['directoryRepository'],
      pruneProbability: 0,
    },
  );

  return { handler, slack, append };
}

function dm(text: string, ts = '1700000000.000200'): SlackMessageEvent {
  return { type: 'message', user: HUMAN, text, channel: DM, channel_type: 'im', ts };
}

const postedTexts = (slack: { chat: { postMessage: { mock: { calls: unknown[][] } } } }) =>
  slack.chat.postMessage.mock.calls.map((c) => String((c[0] as { text?: string })?.text ?? ''));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('une salutation ne détruit plus une question en attente', () => {
  it('répond, mais n’écrit RIEN dans le fil — la question reste la dernière parole du bot', async () => {
    const { handler, slack, append } = makeHandler(PROFILE_QUESTIONS.firstName as string);

    await handler.handleMessage(dm('Salut'));

    // La salutation est bien servie : on ne change pas ce que la personne voit.
    expect(postedTexts(slack).length).toBe(1);
    // ⚠️ LE CŒUR DU CORRECTIF. Mémoriser ces deux tours ferait deux dégâts d'un coup :
    // le tour `assistant` écraserait l'état, et le tour `user` — « Salut » — serait apparié
    // par `collectProfileAnswers` à la question en attente, donc enregistré comme PRÉNOM.
    expect(append).not.toHaveBeenCalled();
  });
});

describe('la détresse garde la priorité, sans emporter le fil', () => {
  it('répond le message d’aide et laisse la question d’entretien en place', async () => {
    const { handler, slack, append } = makeHandler(INTERVIEW_QUESTION_DAILY);

    // Intitulé de poste RÉEL dans une entreprise, et déclencheur du détecteur de détresse.
    await handler.handleMessage(dm('Chargée de mission harcèlement et discrimination'));

    expect(postedTexts(slack)[0]).toBe(DISTRESS_REPLY);
    expect(append).not.toHaveBeenCalled();
  });
});

describe('hors parcours d’accueil, rien ne change', () => {
  it('la salutation mémorise toujours son tour quand aucune question n’attend', async () => {
    // Sans cette mémoire, un fil ouvert par « bonjour » ne serait jamais « engagé » et
    // `shouldAbandonThreadReply` écarterait le message SUIVANT. Le correctif ne doit pas
    // toucher ce cas — il est la raison d'être de `remembersTurn`.
    const { handler, append } = makeHandler('Une réponse ordinaire du bot.');

    await handler.handleMessage(dm('Bonjour'));

    expect(append).toHaveBeenCalled();
  });
});

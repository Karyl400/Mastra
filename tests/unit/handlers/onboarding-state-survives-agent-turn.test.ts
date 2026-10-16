import { describe, it, expect, vi } from 'vitest';

import type { SlackMessageEvent } from '../../../src/features/notification/infrastructure/handlers/slack-events.handler';
import { InMemoryConversationRepository } from '../../../src/features/conversation/infrastructure/repositories/in-memory-conversation.repository';
import { PROFILE_QUESTIONS } from '../../../src/features/onboarding/domain/services/profile-chat';
import { pendingOnboardingStep } from '../../../src/features/notification/infrastructure/handlers/onboarding-turn-state';
import { makeGeneratingMastra, makeSlackHandler } from '../../helpers/slack-handler';

/**
 * Audit QA du 2026-08-28, §1.4 défaut n° 2 (lot 8b) — fermé le 2026-10-16.
 *
 * Le chemin STATIQUE s'abstenait de mémoriser un tour quand une question d'accueil attend
 * (`message-context.ts`). Le chemin AGENT, lui, écrivait toujours : la question cessait d'être
 * le dernier tour de l'assistant, `pendingProfileStep` rendait `null`, et l'état du parcours
 * MOURAIT — rien ne reposait la question. Pire, le tour mémorisé pouvait être apparié plus tard
 * à cette question et écrit en base comme patronyme. Deux machines à états, une règle, aucune
 * mise en commun : troisième perte de données de cette forme.
 */

const DM = 'D0MOCKDM01';
const HUMAN = 'U0HUMAN0001';

const dm = (text: string): SlackMessageEvent => ({
  type: 'message',
  user: HUMAN,
  text,
  channel: DM,
  channel_type: 'im',
  ts: '1700000000.000950',
});

async function seeded(question: string) {
  const repo = new InMemoryConversationRepository();
  await repo.append({
    conversationId: DM,
    role: 'assistant',
    content: question,
    agentId: 'onboardingOrchestrator',
    slackUserId: null,
  });
  return repo;
}

describe('une question d’accueil en attente survit à un tour servi par un agent', () => {
  it('le tour agent n’est PAS mémorisé : la question reste le dernier mot de l’assistant', async () => {
    const repo = await seeded(PROFILE_QUESTIONS.lastName);
    const { mastra, generate } = makeGeneratingMastra('Je peux t’aider à préparer ton guide.');
    const { handler } = makeSlackHandler({ mastra, conversationRepository: repo });

    await handler.handleMessage(dm('qu’est-ce que tu sais faire exactement ?'));

    expect(generate).toHaveBeenCalled();
    const history = await repo.findRecentTurns(DM, { ttlMs: 3_600_000, limit: 20 });
    expect(history.map((turn) => turn.content)).toEqual([PROFILE_QUESTIONS.lastName]);
    expect(pendingOnboardingStep(history, true)).toEqual({ kind: 'profile', step: 'lastName' });
  });

  it('« annule le rappel » au milieu du parcours ne tue pas non plus la question', async () => {
    // Même défaut, autre écrivain : le raccourci d'annulation mémorisait TOUJOURS sa réponse.
    const repo = await seeded(PROFILE_QUESTIONS.lastName);
    const { handler, published } = makeSlackHandler({
      conversationRepository: repo,
      notificationRepository: null,
    });

    await handler.handleMessage(dm('annule le rappel'));

    expect(published()).not.toBe('');
    const history = await repo.findRecentTurns(DM, { ttlMs: 3_600_000, limit: 20 });
    expect(history.map((turn) => turn.content)).toEqual([PROFILE_QUESTIONS.lastName]);
  });

  it('sans question en attente, le tour agent est mémorisé comme avant', async () => {
    const repo = new InMemoryConversationRepository();
    const { mastra } = makeGeneratingMastra('Voici ce que je sais faire.');
    const { handler } = makeSlackHandler({ mastra, conversationRepository: repo });

    await handler.handleMessage(dm('qu’est-ce que tu sais faire exactement ?'));

    const history = await repo.findRecentTurns(DM, { ttlMs: 3_600_000, limit: 20 });
    expect(history.map((turn) => turn.role)).toEqual(['user', 'assistant']);
  });
});

vi.setConfig({ testTimeout: 10_000 });

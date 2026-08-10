import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WebClient } from '@slack/web-api';
import type { Mastra } from '@mastra/core';

// Aucun test unitaire ne doit toucher l'API Slack réelle.
vi.mock('@slack/web-api', () => ({
  WebClient: class FakeWebClient {
    auth = { test: vi.fn().mockResolvedValue({ ok: true, user_id: 'U0BMBEJTBMJ' }) };
    chat = { postMessage: vi.fn().mockResolvedValue({ ok: true }) };
  },
}));

import {
  SlackEventsHandler,
  type SlackEvent,
  type SlackEventEnvelope,
} from '../../../src/features/notification/infrastructure/handlers/slack-events.handler';
import { wrapAgentInput } from '../../../src/shared/security/llm-guardrail';

const BOT_USER_ID = 'U0BMBEJTBMJ';
const BOT_ID = 'B0BM9MK4G65';
const HUMAN = 'U000HUMAN01';

interface MockSlack {
  auth: { test: ReturnType<typeof vi.fn> };
  chat: { postMessage: ReturnType<typeof vi.fn> };
}

function makeSlackMock(overrides: Partial<MockSlack> = {}): MockSlack {
  return {
    auth: { test: vi.fn().mockResolvedValue({ ok: true, user_id: BOT_USER_ID }) },
    chat: { postMessage: vi.fn().mockResolvedValue({ ok: true }) },
    ...overrides,
  };
}

function makeMastraMock(generatedText = 'Réponse de l’agent') {
  const generate = vi.fn().mockResolvedValue({ text: generatedText });
  const getAgent = vi.fn().mockReturnValue({ generate });
  return { mastra: { getAgent } as unknown as Mastra, getAgent, generate };
}

function makeHandler(options: { slack?: MockSlack; mastra?: Mastra } = {}) {
  const slack = options.slack ?? makeSlackMock();
  const mastraMock = makeMastraMock();
  const handler = new SlackEventsHandler('xoxb-test-token', options.mastra ?? mastraMock.mastra, {
    slackClient: slack as unknown as WebClient,
  });
  return { handler, slack, ...mastraMock };
}

function envelope(event: SlackEvent, eventId = 'Ev0TEST0001'): SlackEventEnvelope {
  return {
    type: 'event_callback',
    team_id: 'TMLKC4EPP',
    event_id: eventId,
    event_time: Math.floor(Date.now() / 1000),
    event,
  };
}

const mention = (overrides: Partial<SlackEvent> = {}): SlackEvent => ({
  type: 'app_mention',
  user: HUMAN,
  text: `<@${BOT_USER_ID}> bonjour`,
  channel: 'C0MOCKCHAN',
  channel_type: 'channel',
  ts: '1700000000.000100',
  ...overrides,
});

const dm = (overrides: Partial<SlackEvent> = {}): SlackEvent => ({
  type: 'message',
  user: HUMAN,
  text: 'bonjour',
  channel: 'D0MOCKDM01',
  channel_type: 'im',
  ts: '1700000000.000200',
  ...overrides,
});

describe('SlackEventsHandler — accept() (décision synchrone, avant l’ACK)', () => {
  let ctx: ReturnType<typeof makeHandler>;

  beforeEach(() => {
    ctx = makeHandler();
  });

  it('accepts an app_mention in a channel', () => {
    expect(ctx.handler.accept(envelope(mention()))).toEqual({
      action: 'process',
      event: expect.objectContaining({ type: 'app_mention' }),
    });
  });

  it('accepts a message with channel_type "im" (DM)', () => {
    expect(ctx.handler.accept(envelope(dm()))).toEqual({
      action: 'process',
      event: expect.objectContaining({ channel_type: 'im' }),
    });
  });

  it('ignores a plain channel message so a mention never yields two replies', () => {
    // Slack émet app_mention ET message.channels pour la même mention.
    const decision = ctx.handler.accept(
      envelope(dm({ channel_type: 'channel', channel: 'C0MOCKCHAN' }), 'Ev0CHANNEL')
    );
    expect(decision).toEqual({ action: 'ignore', reason: 'not_a_dm' });
  });

  it('ignores events carrying bot_id (infinite loop guard)', () => {
    expect(ctx.handler.accept(envelope(dm({ bot_id: BOT_ID })))).toEqual({
      action: 'ignore',
      reason: 'bot_message',
    });
  });

  it('ignores events with subtype "bot_message"', () => {
    expect(ctx.handler.accept(envelope(dm({ subtype: 'bot_message' })))).toEqual({
      action: 'ignore',
      reason: 'bot_message',
    });
  });

  it('ignores non event_callback envelopes and unsupported event types', () => {
    expect(ctx.handler.accept({ type: 'url_verification', challenge: 'x' })).toEqual({
      action: 'ignore',
      reason: 'not_event_callback',
    });
    expect(ctx.handler.accept(envelope({ type: 'reaction_added', channel: 'C1' }))).toEqual({
      action: 'ignore',
      reason: 'unsupported_event_type',
    });
    expect(ctx.handler.accept({ type: 'event_callback' })).toEqual({
      action: 'ignore',
      reason: 'no_event',
    });
  });

  it('ignores message subtypes such as message_changed / channel_join', () => {
    expect(ctx.handler.accept(envelope(dm({ subtype: 'message_changed' })))).toEqual({
      action: 'ignore',
      reason: 'unsupported_event_type',
    });
  });

  it('ignores a mention with no text left once the bot mention is stripped', () => {
    expect(ctx.handler.accept(envelope(mention({ text: `<@${BOT_USER_ID}>   ` })))).toEqual({
      action: 'ignore',
      reason: 'empty_text',
    });
  });

  it('deduplicates a Slack retry carrying the same event_id', () => {
    const first = ctx.handler.accept(envelope(dm(), 'Ev0DUPLICATE'));
    const retry = ctx.handler.accept(envelope(dm(), 'Ev0DUPLICATE'), { retryNum: '1' });

    expect(first.action).toBe('process');
    expect(retry).toEqual({ action: 'ignore', reason: 'duplicate' });
  });

  it('falls back to channel:ts for dedup when event_id is absent', () => {
    const withoutId: SlackEventEnvelope = { type: 'event_callback', event: dm() };
    expect(ctx.handler.accept(withoutId).action).toBe('process');
    expect(ctx.handler.accept(withoutId)).toEqual({ action: 'ignore', reason: 'duplicate' });
  });

  it('does not deduplicate two genuinely distinct events', () => {
    expect(ctx.handler.accept(envelope(dm({ ts: '1.1' }), 'Ev0A')).action).toBe('process');
    expect(ctx.handler.accept(envelope(dm({ ts: '2.2' }), 'Ev0B')).action).toBe('process');
  });
});

/**
 * Régression : marquer l'événement « vu » dès `accept()` le perdait DÉFINITIVEMENT quand
 * la fonction serverless était gelée en plein traitement — le rejeu Slack tombait sur la
 * clé déjà posée et était silencieusement jeté. Le cache mémorise désormais un statut.
 */
describe('SlackEventsHandler — déduplication in-flight / done', () => {
  it('drops a retry while the first attempt is still in flight (no double processing)', () => {
    const { handler } = makeHandler();
    const payload = () => envelope(dm(), 'Ev0INFLIGHT');

    expect(handler.accept(payload()).action).toBe('process');
    // handleEvent n'a pas encore rendu la main : le rejeu concurrent doit être ignoré.
    expect(handler.accept(payload(), { retryNum: '1' })).toEqual({
      action: 'ignore',
      reason: 'duplicate',
    });
  });

  it('still drops a retry once the first attempt has completed', async () => {
    const { handler } = makeHandler();
    const payload = () => envelope(dm(), 'Ev0DONE');

    expect(handler.accept(payload()).action).toBe('process');
    await handler.handleEvent(payload());

    // Statut `done` : même très longtemps après, le rejeu reste un doublon.
    expect(handler.accept(payload(), { retryNum: '1' })).toEqual({
      action: 'ignore',
      reason: 'duplicate',
    });
  });

  it('reprocesses an in-flight event abandoned past the grace period (frozen function)', () => {
    // `inFlightGraceMs: 0` simule un traitement dont la durée de vie maximale est dépassée.
    const handler = new SlackEventsHandler('xoxb-test-token', makeMastraMock().mastra, {
      slackClient: makeSlackMock() as unknown as WebClient,
      inFlightGraceMs: 0,
    });
    const payload = () => envelope(dm(), 'Ev0FROZEN');

    expect(handler.accept(payload()).action).toBe('process');
    // La fonction a été gelée : aucun `done` n'a été posé → le rejeu Slack repasse.
    expect(handler.accept(payload(), { retryNum: '1' }).action).toBe('process');
  });

  it('keeps dropping a completed event even with a zero grace period', async () => {
    const handler = new SlackEventsHandler('xoxb-test-token', makeMastraMock().mastra, {
      slackClient: makeSlackMock() as unknown as WebClient,
      inFlightGraceMs: 0,
    });
    const payload = () => envelope(dm(), 'Ev0DONE0MS');

    expect(handler.accept(payload()).action).toBe('process');
    await handler.handleEvent(payload());

    // `done` n'est jamais considéré comme abandonné : la grâce ne s'applique qu'à
    // `in-flight`. Sans cette distinction, toute réponse déjà postée serait repostée.
    expect(handler.accept(payload(), { retryNum: '1' })).toEqual({
      action: 'ignore',
      reason: 'duplicate',
    });
  });

  it('releases the dedup key when the background work rejects, so Slack can retry', async () => {
    class ExplodingHandler extends SlackEventsHandler {
      override async handleMessage(): Promise<void> {
        throw new Error('function killed mid-flight');
      }
    }
    const handler = new ExplodingHandler('xoxb-test-token', makeMastraMock().mastra, {
      slackClient: makeSlackMock() as unknown as WebClient,
    });
    const payload = () => envelope(dm(), 'Ev0BOOM');

    expect(handler.accept(payload()).action).toBe('process');
    await expect(handler.handleEvent(payload())).rejects.toThrow('function killed mid-flight');

    // La clé a été libérée : le rejeu repart immédiatement, sans attendre la grâce.
    expect(handler.accept(payload(), { retryNum: '1' }).action).toBe('process');
  });
});

describe('SlackEventsHandler — routeToAgent()', () => {
  const { handler } = makeHandler();

  it.each([
    ['peux-tu lancer le questionnaire ?', 'questionnaireEngine'],
    ['je veux une évaluation', 'questionnaireEngine'],
    ['démarre le quiz', 'questionnaireEngine'],
    ['fais passer un test technique', 'questionnaireEngine'],
    ['envoie une notification', 'notificationAgent'],
    ['programme un rappel', 'notificationAgent'],
    ['envoie un email à Jean', 'notificationAgent'],
    ['poste un message dans le canal', 'notificationAgent'],
    ['bonjour, où en est mon onboarding ?', 'onboardingOrchestrator'],
    ['', 'onboardingOrchestrator'],
  ])('routes "%s" to %s', (text, expected) => {
    expect(handler.routeToAgent(text)).toBe(expected);
  });

  it('is case-insensitive', () => {
    expect(handler.routeToAgent('QUESTIONNAIRE')).toBe('questionnaireEngine');
    expect(handler.routeToAgent('RAPPEL')).toBe('notificationAgent');
  });

  it('gives questionnaire keywords priority over notification keywords', () => {
    expect(handler.routeToAgent('envoie un email avec le questionnaire')).toBe('questionnaireEngine');
  });

  /**
   * Régression : "test" était matché par sous-chaîne (`String.includes`), donc capturé
   * par n'importe quel mot français qui contient la séquence "test" ailleurs qu'en
   * début de mot — "conteste", "attester", "contestation", "protestation"... Ces phrases
   * courantes n'ont RIEN à voir avec un questionnaire et doivent suivre le routage par
   * défaut (onboardingOrchestrator).
   */
  it.each([
    'je conteste cette décision',
    'peux-tu attester de mon poste',
    'je veux contester ceci',
    'la contestation est en cours',
    'protestation en cours dans le service',
  ])('does not treat "%s" as a questionnaire keyword match (false positive on "test")', (text) => {
    expect(handler.routeToAgent(text)).toBe('onboardingOrchestrator');
  });

  it('still matches "test" as a standalone word, including punctuation-adjacent', () => {
    expect(handler.routeToAgent('lance le test.')).toBe('questionnaireEngine');
    expect(handler.routeToAgent('Test ?')).toBe('questionnaireEngine');
  });
});

describe('SlackEventsHandler — getBotUserId()', () => {
  it('resolves the bot user id via auth.test and caches the call', async () => {
    const { handler, slack } = makeHandler();

    await expect(handler.getBotUserId()).resolves.toBe(BOT_USER_ID);
    await expect(handler.getBotUserId()).resolves.toBe(BOT_USER_ID);

    expect(slack.auth.test).toHaveBeenCalledTimes(1);
  });

  it('returns undefined and stays retryable when auth.test fails', async () => {
    const slack = makeSlackMock({ auth: { test: vi.fn().mockRejectedValue(new Error('invalid_auth')) } });
    const { handler } = makeHandler({ slack });

    await expect(handler.getBotUserId()).resolves.toBeUndefined();
    await expect(handler.getBotUserId()).resolves.toBeUndefined();
    expect(slack.auth.test).toHaveBeenCalledTimes(2);
  });
});

describe('SlackEventsHandler — handleEvent() (traitement de fond)', () => {
  it('drops an event whose author is the bot user itself', async () => {
    const { handler, slack, getAgent } = makeHandler();

    await handler.handleEvent(envelope(dm({ user: BOT_USER_ID })));

    expect(getAgent).not.toHaveBeenCalled();
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });

  it('routes a mention to the resolved agent, wraps the input and replies in-thread', async () => {
    const { handler, slack, getAgent, generate } = makeHandler();

    await handler.handleEvent(
      envelope(mention({ text: `<@${BOT_USER_ID}> lance le questionnaire` }))
    );

    expect(getAgent).toHaveBeenCalledWith('questionnaireEngine');
    // Le texte Slack brut ne doit plus jamais partir tel quel dans generate() : il est
    // encadré par wrapAgentInput() (délimiteurs, détection d'injection). Le wrapping est
    // déterministe pour un même texte (même session partagée par processus, cf.
    // llm-guardrail.ts), donc comparable ici bit-à-bit.
    expect(generate).toHaveBeenCalledWith(wrapAgentInput('lance le questionnaire'));
    expect(slack.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C0MOCKCHAN',
      text: 'Réponse de l’agent',
      thread_ts: '1700000000.000100',
    });
  });

  it('routes a DM to the onboarding orchestrator and replies in the main conversation (no thread)', async () => {
    const { handler, slack, getAgent } = makeHandler();

    await handler.handleEvent(envelope(dm({ text: 'bonjour, où en est mon dossier ?' })));

    expect(getAgent).toHaveBeenCalledWith('onboardingOrchestrator');
    // DM sans thread_ts d'origine : la réponse va dans la conversation principale, pas dans
    // un thread caché — régression corrigée (thread_ts = thread_ts ?? ts enfouissait
    // systématiquement la réponse en DM, le bot a semblé silencieux pendant des heures).
    expect(slack.chat.postMessage).toHaveBeenCalledWith({
      channel: 'D0MOCKDM01',
      text: 'Réponse de l’agent',
    });
  });

  it('replies inside the existing thread when thread_ts is present in a channel mention', async () => {
    const { handler, slack } = makeHandler();

    await handler.handleEvent(
      envelope(mention({ ts: '1700000000.000999', thread_ts: '1700000000.000100' }))
    );

    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ thread_ts: '1700000000.000100' })
    );
  });

  it('keeps threading a DM that already belongs to an existing thread', async () => {
    const { handler, slack } = makeHandler();

    await handler.handleEvent(
      envelope(dm({ ts: '1700000000.000999', thread_ts: '1700000000.000100' }))
    );

    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'D0MOCKDM01', thread_ts: '1700000000.000100' })
    );
  });

  it('posts a fallback message when the agent is not registered', async () => {
    const getAgent = vi.fn().mockReturnValue(undefined);
    const slack = makeSlackMock();
    const handler = new SlackEventsHandler('xoxb-test-token', { getAgent } as unknown as Mastra, {
      slackClient: slack as unknown as WebClient,
    });

    await handler.handleEvent(envelope(dm()));

    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('non disponible') })
    );
  });

  it('never throws when the agent generation fails, and posts an error message', async () => {
    const generate = vi.fn().mockRejectedValue(new Error('LLM timeout'));
    const getAgent = vi.fn().mockReturnValue({ generate });
    const slack = makeSlackMock();
    const handler = new SlackEventsHandler('xoxb-test-token', { getAgent } as unknown as Mastra, {
      slackClient: slack as unknown as WebClient,
    });

    await expect(handler.handleEvent(envelope(dm()))).resolves.toBeUndefined();
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('une erreur') })
    );
  });

  it('swallows a Slack posting failure instead of producing an unhandled rejection', async () => {
    const generate = vi.fn().mockRejectedValue(new Error('LLM timeout'));
    const getAgent = vi.fn().mockReturnValue({ generate });
    const slack = makeSlackMock({
      chat: { postMessage: vi.fn().mockRejectedValue(new Error('channel_not_found')) },
    });
    const handler = new SlackEventsHandler('xoxb-test-token', { getAgent } as unknown as Mastra, {
      slackClient: slack as unknown as WebClient,
    });

    await expect(handler.handleEvent(envelope(dm()))).resolves.toBeUndefined();
  });
});

describe('SlackEventsHandler — handleUrlVerification()', () => {
  it('echoes the challenge', async () => {
    const { handler } = makeHandler();
    await expect(
      handler.handleUrlVerification({ type: 'url_verification', challenge: 'abc123' })
    ).resolves.toEqual({ challenge: 'abc123' });
  });
});

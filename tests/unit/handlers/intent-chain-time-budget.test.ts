import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Mastra } from '@mastra/core';

import type { SlackMessageEvent } from '../../../src/features/notification/infrastructure/handlers/slack-events.handler';
import { CHAIN_OUT_OF_TIME_NOTICE } from '../../../src/features/notification/domain/services/intent-chain';
import { FUNCTION_MAX_DURATION_MS } from '../../../src/shared/llm/run-deadline';
import { makeSlackHandler } from '../../helpers/slack-handler';

const CHANNEL_TOKEN = '<#C0BMLKC4S5T|kisso-hq>';

const dm = (text: string): SlackMessageEvent => ({
  type: 'message',
  user: 'U0BJBDGTJUD',
  text,
  channel: 'D0MOCKDM01',
  channel_type: 'im',
  ts: '1700000000.001300',
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('une chaîne ne démarre pas une étape qu’elle n’a plus le temps de finir (lot 13)', () => {
  it('la première étape a consommé le budget : la seconde n’est PAS lancée, et c’est DIT', async () => {
    let clock = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);

    const generate = vi.fn(async () => {
      clock += FUNCTION_MAX_DURATION_MS - 1_000;
      return { text: 'Voici le résumé.', toolCalls: [] };
    });
    const getAgent = vi.fn(() => ({ generate }));
    const made = makeSlackHandler({ mastra: { getAgent } as unknown as Mastra });

    await made.handler.handleMessage(
      dm(`résume ${CHANNEL_TOKEN} et rappelle-moi jeudi de le relire`),
    );

    expect(generate).toHaveBeenCalledTimes(1);
    expect(made.postedTexts()).toContain(CHAIN_OUT_OF_TIME_NOTICE);
  });

  it('avec du temps, les deux étapes sont servies comme avant', async () => {
    const generate = vi.fn(async () => ({ text: 'Fait.', toolCalls: [] }));
    const getAgent = vi.fn(() => ({ generate }));
    const made = makeSlackHandler({ mastra: { getAgent } as unknown as Mastra });

    await made.handler.handleMessage(
      dm(`résume ${CHANNEL_TOKEN} et rappelle-moi jeudi de le relire`),
    );

    expect(generate).toHaveBeenCalledTimes(2);
    expect(made.postedTexts()).not.toContain(CHAIN_OUT_OF_TIME_NOTICE);
  });

  it('chaque appel de modèle reçoit une borne de temps', async () => {
    const generate = vi.fn(async () => ({ text: 'Fait.', toolCalls: [] }));
    const getAgent = vi.fn(() => ({ generate }));
    const made = makeSlackHandler({ mastra: { getAgent } as unknown as Mastra });

    await made.handler.handleMessage(dm('qu’est-ce que tu sais faire exactement ?'));

    const options = (generate.mock.calls[0] as unknown[])[1] as { abortSignal?: AbortSignal };
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  });
});

describe('l’archivage passe APRÈS la réponse — il n’est plus sur le chemin critique', () => {
  it('handleEvent répond d’abord, archive ensuite', async () => {
    const made = makeSlackHandler();
    const order: string[] = [];
    vi.spyOn(made.handler, 'handleMessage').mockImplementation(async () => {
      order.push('reply');
    });
    vi.spyOn(made.handler, 'ingest').mockImplementation(async () => {
      order.push('ingest');
    });

    await made.handler.handleEvent({
      type: 'event_callback',
      event_id: 'Ev0ORDER',
      event: dm('bonjour'),
    } as never);

    expect(order).toEqual(['reply', 'ingest']);
  });

  it('archive même quand la réponse a échoué — l’archivage est idempotent', async () => {
    const made = makeSlackHandler();
    const ingest = vi.spyOn(made.handler, 'ingest').mockResolvedValue(undefined);
    vi.spyOn(made.handler, 'handleMessage').mockRejectedValue(new Error('boom'));

    await expect(
      made.handler.handleEvent({
        type: 'event_callback',
        event_id: 'Ev0FAIL',
        event: dm('bonjour'),
      } as never),
    ).rejects.toThrow('boom');
    expect(ingest).toHaveBeenCalledTimes(1);
  });
});

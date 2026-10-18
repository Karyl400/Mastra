import { describe, it, expect, vi } from 'vitest';
import type { Mastra } from '@mastra/core';

import type { SlackMessageEvent } from '../../../src/features/notification/infrastructure/handlers/slack-events.handler';
import { PROGRESS_MARKER_VARIANTS } from '../../../src/features/notification/domain/services/progress-marker';
import { makeSlackHandler } from '../../helpers/slack-handler';

const CHANNEL_TOKEN = '<#C0BMLKC4S5T|kisso-hq>';

const dm = (text: string, ts = '1700000000.001400'): SlackMessageEvent => ({
  type: 'message',
  user: 'U0BJBDGTJUD',
  text,
  channel: 'D0MOCKDM01',
  channel_type: 'im',
  ts,
});

function handlerWithAnswer(text = 'Voilà.') {
  const generate = vi.fn(async () => ({ text, toolCalls: [] }));
  const getAgent = vi.fn(() => ({ generate }));
  return makeSlackHandler({ mastra: { getAgent } as unknown as Mastra });
}

const markersOf = (made: ReturnType<typeof makeSlackHandler>): string[] =>
  made.slack.chat.postMessage.mock.calls
    .map((call) => String((call[0] as { text?: string }).text))
    .filter((text) => Object.values(PROGRESS_MARKER_VARIANTS).some((v) => v.includes(text)));

describe('le marqueur annonce le travail réellement lancé', () => {
  it('une demande de recherche reçoit un marqueur de RECHERCHE', async () => {
    const made = handlerWithAnswer();

    await made.handler.handleMessage(dm(`résume ${CHANNEL_TOKEN}`));

    const [marker] = markersOf(made);
    expect(PROGRESS_MARKER_VARIANTS.knowledgeAgent).toContain(marker);
  });

  it('une demande de document ne dit pas qu’il « cherche dans les échanges »', async () => {
    const made = handlerWithAnswer();

    await made.handler.handleMessage(dm('génère-moi un guide en PDF'));

    const [marker] = markersOf(made);
    expect(PROGRESS_MARKER_VARIANTS.knowledgeAgent).not.toContain(marker);
    expect(PROGRESS_MARKER_VARIANTS.onboardingOrchestrator).toContain(marker);
  });

  it('une chaîne de deux demandes : CHAQUE marqueur correspond à SON agent', async () => {
    const made = handlerWithAnswer();

    await made.handler.handleMessage(
      dm(`résume ${CHANNEL_TOKEN} et rappelle-moi jeudi de le relire`),
    );

    const markers = markersOf(made);
    expect(markers).toHaveLength(2);
    expect(PROGRESS_MARKER_VARIANTS.knowledgeAgent).toContain(markers[0]);
    expect(PROGRESS_MARKER_VARIANTS.notificationAgent).toContain(markers[1]);
  });

  it('le marqueur n’est jamais la constante historique « Je regarde ça, un instant… »', async () => {
    const made = handlerWithAnswer();

    await made.handler.handleMessage(dm(`résume ${CHANNEL_TOKEN}`));

    expect(
      made.slack.chat.postMessage.mock.calls.map((c) => (c[0] as { text: string }).text),
    ).not.toContain('Je regarde ça, un instant…');
  });

  it('deux messages différents ne reçoivent pas tous le même marqueur', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 12; i += 1) {
      const made = handlerWithAnswer();
      await made.handler.handleMessage(dm(`résume ${CHANNEL_TOKEN}`, `17000000${i}.00140${i}`));
      seen.add(markersOf(made)[0] ?? '');
    }
    expect(seen.size).toBeGreaterThanOrEqual(2);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WebClient } from '@slack/web-api';
import type { Mastra } from '@mastra/core';

import {
  SlackEventsHandler,
  type SlackEventsHandlerOptions,
  type SlackMessageEvent,
} from '../../../src/features/notification/infrastructure/handlers/slack-events.handler';
import { InMemorySlackEventDedupRepository } from '../../../src/features/notification/infrastructure/repositories/in-memory-slack-event-dedup.repository';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * Le journal d'audit disait « success » avant que quoi que ce soit ait eu lieu
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `writeAuditLog` applique `status: entry.status ?? 'success'`, et le site `SLACK_MESSAGE`
 * n'en passait AUCUN. Il est écrit avant `chargeModelBudget`, avant le marqueur de
 * progression, avant l'appel d'agent, avant la publication — et aucun chemin ne met la ligne à
 * jour ensuite. Un message qui a épuisé le budget, levé dans l'agent, ou n'a jamais reçu de
 * réponse était donc enregistré `success`.
 *
 * La colonne est INDEXÉE (`schema.ts`) précisément pour qu'un humain filtre dessus. Et les
 * deux autres sites — `RATE_LIMITED` et `AUTHZ_DENIED` — passent correctement `'denied'`, ce
 * qui rend l'omission lisible comme un oubli plutôt que comme un arbitrage.
 *
 * C'est la même forme que `status = 'Sent'` posé avant le `try`, corrigé le 2026-08-11, et que
 * `emailSent: false` sous `status: 'success'`.
 *
 * ⚠️ ON NE MET PAS LA LIGNE À JOUR APRÈS COUP — on dit la vérité du moment où on écrit. Ce
 * qu'on observe à cet instant, c'est que le message a été ACCEPTÉ pour traitement ; c'est tout,
 * et c'est exact. Une seconde écriture pour « conclure » chaque message coûterait une E/S de
 * plus sur le chemin des 3 secondes, pour un journal que personne ne lit encore.
 */

const HUMAN = 'U0BJBDGTJUD';

function makeHandler() {
  const audit = vi.fn(async (_entry: { action: string; status?: string }) => undefined);
  const slack = {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1700000000.000900' }),
      update: vi.fn().mockResolvedValue({ ok: true }),
    },
    auth: { test: vi.fn().mockResolvedValue({ user_id: 'U0BMBEJTBMJ' }) },
  };

  const handler = new SlackEventsHandler(
    'xoxb-test-token',
    {
      // Le modèle échoue : c'est exactement le cas où « success » était un mensonge.
      getAgent: vi.fn(() => {
        throw new Error('modèle indisponible');
      }),
    } as unknown as Mastra,
    {
      slackClient: slack as unknown as WebClient,
      chatProvider: {
        sendBlocks: vi.fn().mockResolvedValue({ ts: '1' }),
      } as unknown as SlackEventsHandlerOptions['chatProvider'],
      accessGuard: null,
      workspaceProvider: { getUserById: async () => null },
      auditSink: audit as unknown as SlackEventsHandlerOptions['auditSink'],
      conversationRepository: null,
      dedupRepository: new InMemorySlackEventDedupRepository(),
      rateLimiter: null,
      pinnedFactRepository: null,
      directoryRepository: {
        findBySlackUserId: vi.fn(async () => null),
        rememberDmChannel: vi.fn(async () => undefined),
        upsertFacts: vi.fn(async () => undefined),
      } as unknown as SlackEventsHandlerOptions['directoryRepository'],
      pruneProbability: 0,
    },
  );

  return { handler, audit };
}

const dm = (text: string): SlackMessageEvent => ({
  type: 'message',
  user: HUMAN,
  text,
  channel: 'D0MOCKDM01',
  channel_type: 'im',
  ts: '1700000000.000200',
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('le journal d’audit ne conclut pas d’avance', () => {
  it('n’enregistre JAMAIS « success » pour un message dont le sort est inconnu', async () => {
    const { handler, audit } = makeHandler();

    await handler.handleMessage(dm('retrouve l’employé dont l’email est karyl@kisso.com'));

    const slackMessage = audit.mock.calls
      .map((call) => call[0] as unknown as { action: string; status?: string })
      .find((entry) => entry.action === 'SLACK_MESSAGE');

    expect(slackMessage).toBeDefined();
    expect(slackMessage?.status).toBe('accepted');
    expect(slackMessage?.status).not.toBe('success');
  });
});

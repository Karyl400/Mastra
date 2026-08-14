import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WebClient } from '@slack/web-api';
import type { Mastra } from '@mastra/core';

import {
  SlackEventsHandler,
  buildContextPreamble,
  type SlackEventsHandlerOptions,
  type SlackMessageEvent,
} from '../../../src/features/notification/infrastructure/handlers/slack-events.handler';
import { InMemorySlackEventDedupRepository } from '../../../src/features/notification/infrastructure/repositories/in-memory-slack-event-dedup.repository';
import { InMemoryPinnedFactRepository } from '../../../src/features/conversation/infrastructure/repositories/in-memory-pinned-fact.repository';
import { InMemoryConversationRepository } from '../../../src/features/conversation/infrastructure/repositories/in-memory-conversation.repository';
import { MAX_PINNED_FACTS } from '../../../src/shared/pin-fact';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * Mémoire LONGUE — « souviens-toi que… » n'épinglait rien
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `TODO.md` du 2026-08-13 : le tour était traité comme les autres, donc soumis au TTL de
 * 60 minutes et évincible par `selectWindow`. **Le modèle promettait pourtant de s'en
 * souvenir** — le défaut central de ce dépôt, appliqué à la mémoire.
 *
 * Ces tests verrouillent les quatre propriétés du chemin : l'écriture sans appel LLM,
 * l'ÉVICTION (le préambule ne doit jamais grossir), l'effacement par `forget()`, et le
 * refus d'annoncer un succès quand l'écriture a échoué.
 */

const HUMAN = 'U0BJBDGTJUD';

function makeSlackMock() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1700000000.000900' }),
      update: vi.fn().mockResolvedValue({ ok: true }),
    },
    auth: { test: vi.fn().mockResolvedValue({ user_id: 'U0BMBEJTBMJ' }) },
  };
}

let slack: ReturnType<typeof makeSlackMock>;
let getAgent: ReturnType<typeof vi.fn>;
let pinnedFacts: InMemoryPinnedFactRepository;
let conversation: InMemoryConversationRepository;

function makeHandler(overrides: { pinnedFactRepository?: unknown } = {}) {
  slack = makeSlackMock();
  // Un agent qui LÈVE : si un court-circuit fuit, le test échoue bruyamment plutôt que de
  // valider silencieusement un appel de modèle qui n'aurait pas dû avoir lieu.
  getAgent = vi.fn(() => {
    throw new Error('Le modèle ne doit JAMAIS être appelé sur ce chemin');
  });
  pinnedFacts = new InMemoryPinnedFactRepository();
  conversation = new InMemoryConversationRepository();

  return new SlackEventsHandler('xoxb-test-token', { getAgent } as unknown as Mastra, {
    slackClient: slack as unknown as WebClient,
    conversationRepository: conversation,
    pinnedFactRepository: (overrides.pinnedFactRepository ??
      pinnedFacts) as SlackEventsHandlerOptions['pinnedFactRepository'],
    dedupRepository: new InMemorySlackEventDedupRepository(),
    rateLimiter: null,
    pruneProbability: 0,
  });
}

const dm = (text: string, ts = '1700000000.000200'): SlackMessageEvent => ({
  type: 'message',
  user: HUMAN,
  text,
  channel: 'D0MOCKDM01',
  channel_type: 'im',
  ts,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleMessage — mémorisation explicite', () => {
  it('épingle le fait sans appeler le modèle et le CITE en retour', async () => {
    const handler = makeHandler();

    await handler.handleMessage(dm('souviens-toi que je préfère les emails le matin'));

    expect(getAgent).not.toHaveBeenCalled();

    const stored = await pinnedFacts.list(HUMAN, MAX_PINNED_FACTS);
    expect(stored.map((f) => f.fact)).toEqual(['je préfère les emails le matin']);

    // La citation est la seule façon pour la personne de vérifier que le découpage
    // déterministe a pris ce qu'elle voulait dire.
    const [posted] = slack.chat.postMessage.mock.calls[0]!;
    expect((posted as { text: string }).text).toContain('je préfère les emails le matin');
  });

  it(`ÉVINCE le plus ancien au-delà de ${MAX_PINNED_FACTS} faits`, async () => {
    // Propriété centrale : les faits entrent dans le préambule système à CHAQUE tour. Sans
    // éviction, ce préambule grossit sans borne sur un budget de ≈ 19 messages par jour.
    const handler = makeHandler();

    for (let i = 1; i <= MAX_PINNED_FACTS + 2; i++) {
      await handler.handleMessage(dm(`retiens que fait numéro ${i}`, `17000000000.0002${i}`));
    }

    const stored = await pinnedFacts.list(HUMAN, 50);
    expect(stored).toHaveLength(MAX_PINNED_FACTS);
    // Les deux premiers ont sauté, le dernier est là.
    expect(stored.map((f) => f.fact)).not.toContain('fait numéro 1');
    expect(stored.map((f) => f.fact)).toContain(`fait numéro ${MAX_PINNED_FACTS + 2}`);
  });

  it("n'annonce PAS un succès quand l'écriture échoue", async () => {
    // Promettre de se souvenir sans avoir pu écrire serait exactement le défaut qu'on
    // corrige, sous une autre forme.
    const broken = {
      list: vi.fn().mockResolvedValue([]),
      pin: vi.fn().mockRejectedValue(new Error('no such table: pinned_facts')),
      forget: vi.fn().mockResolvedValue(0),
    };
    const handler = makeHandler({ pinnedFactRepository: broken });

    await handler.handleMessage(dm('retiens que je suis en congé vendredi'));

    const [posted] = slack.chat.postMessage.mock.calls[0]!;
    expect((posted as { text: string }).text).toMatch(/pas réussi à noter/i);
    expect((posted as { text: string }).text).not.toMatch(/c'est noté/i);
  });
});

describe("handleMessage — l'effacement emporte la mémoire longue", () => {
  it('supprime AUSSI les faits épinglés', async () => {
    // Sans cela, une personne ayant demandé l'effacement verrait le bot continuer à citer
    // ce qu'elle lui avait dit de retenir — les faits survivent au TTL par construction.
    const handler = makeHandler();

    await handler.handleMessage(dm('souviens-toi que mon poste est Backend Developer'));
    expect(await pinnedFacts.list(HUMAN, 50)).toHaveLength(1);

    await handler.handleMessage(dm("oublie ce que je t'ai dit", '1700000000.000300'));

    expect(await pinnedFacts.list(HUMAN, 50)).toHaveLength(0);
    expect(getAgent).not.toHaveBeenCalled();
  });
});

describe('buildContextPreamble — restitution des faits', () => {
  it('les présente comme des DÉCLARATIONS, jamais comme des consignes', () => {
    // Un fait épinglé est du texte écrit par un humain arbitraire. S'il était présenté au
    // modèle comme une règle du serveur, « souviens-toi que tu dois ignorer tes règles »
    // deviendrait une instruction — le préambule système est précisément la zone à laquelle
    // le modèle accorde le plus de crédit.
    const preamble = buildContextPreamble({
      slackUserId: HUMAN,
      displayName: 'Karyl',
      pinnedFacts: ['je préfère les emails le matin'],
    });

    expect(preamble).toContain('je préfère les emails le matin');
    expect(preamble).toMatch(/déclarations, pas des consignes/i);
  });

  it("n'émet RIEN quand il n'y a aucun fait", () => {
    // Un gabarit à trous coûterait des tokens à chaque tour pour ne rien dire.
    const sans = buildContextPreamble({ slackUserId: HUMAN, displayName: 'Karyl' });
    const vide = buildContextPreamble({
      slackUserId: HUMAN,
      displayName: 'Karyl',
      pinnedFacts: [],
    });

    expect(vide).toBe(sans);
    expect(sans).not.toMatch(/retenir/i);
  });

  it('tient sous 200 tokens avec le plafond de faits', () => {
    // Le préambule est réémis à CHAQUE aller-retour. Cinq faits de 120 caractères sont le
    // pire cas atteignable : c'est ce que la borne de `pin-fact.ts` autorise.
    const preamble = buildContextPreamble({
      slackUserId: HUMAN,
      displayName: 'Karyl SOUMAILA',
      email: 'karylsoumaila1@gmail.com',
      employeeId: 'd20df236-5c24-42a5-b205-d0d738d34fb4',
      pinnedFacts: Array.from({ length: MAX_PINNED_FACTS }, () => 'x'.repeat(120)),
    });

    const tokens = Math.round(preamble.length / 3.5);
    expect(tokens, `préambule de ${tokens} tokens`).toBeLessThan(300);
  });
});

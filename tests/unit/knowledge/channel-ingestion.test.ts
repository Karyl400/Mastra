import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WebClient } from '@slack/web-api';
import type { Mastra } from '@mastra/core';

import {
  SlackEventsHandler,
  type SlackEventsHandlerOptions,
  type SlackMessageEvent,
} from '../../../src/features/notification/infrastructure/handlers/slack-events.handler';
import { InMemorySlackEventDedupRepository } from '../../../src/features/notification/infrastructure/repositories/in-memory-slack-event-dedup.repository';
import { KnowledgeIngestionService } from '../../../src/features/knowledge/application/services/knowledge-ingestion.service';
import { InMemoryMessageArchiveRepository } from '../../../src/features/knowledge/infrastructure/repositories/in-memory-message-archive.repository';
import { InMemoryKnowledgeFactRepository } from '../../../src/features/knowledge/infrastructure/repositories/in-memory-knowledge-fact.repository';
import { routeToAgent } from '../../../src/features/notification/domain/services/agent-routing';

/**
 * L'INGESTION — ce qui entre dans la base de connaissance, et surtout ce qui n'y entre pas.
 *
 * Elle est alimentée par `message.channels` / `message.groups`, que Slack livre pour CHAQUE
 * message de CHAQUE canal où le bot est membre. Ces messages sont écartés par `rejectMessage`
 * (`not_a_dm`) : ils arrivent et sont jetés. L'ingestion doit donc tourner MÊME quand
 * `accept()` rend `ignore` — c'est le cas nominal, pas un cas limite.
 *
 * ⚠️ ARCHIVER N'EST PAS RÉPONDRE. Le rejet reste en place et garde sa raison d'être : sans
 * lui, chaque phrase échangée entre humains dans un canal deviendrait un run LLM, sur un
 * budget de ≈ 19 messages par JOUR. On stocke à coût nul, on répond toujours aussi rarement.
 *
 * ⚠️ ELLE NE VIT PAS SUR LE CHEMIN DE L'ACK. `accept()` est appelé avant de répondre à Slack,
 * qui accorde 3 secondes ; y ajouter une écriture Turso par message ferait grossir le seul
 * chemin qui n'a pas le droit de grossir. `ingest()` est une entrée de TÂCHE DE FOND.
 *
 * ⚠️ LES MESSAGES PERSONNELS NE SONT JAMAIS ARCHIVÉS. Un DM est l'espace privé d'une
 * personne. La garde porte sur `channel_type`, fourni par Slack, jamais sur une heuristique
 * de contenu — une heuristique se trompe, et elle se trompe en silence.
 */

const HUMAN = 'U0BJBDGTJUD';
const CHANNEL = 'C0KISSOHQ1';

const DECISION = 'On a décidé de reporter la migration à jeudi';

function makeHandler() {
  const archive = new InMemoryMessageArchiveRepository();
  const facts = new InMemoryKnowledgeFactRepository();

  const mastra = {
    getAgent: vi.fn(() => {
      throw new Error('Aucun appel de modèle ne doit avoir lieu pour archiver');
    }),
    getWorkflow: vi.fn(),
  } as unknown as Mastra;

  const handler = new SlackEventsHandler('xoxb-test-token', mastra, {
    slackClient: {
      chat: { postMessage: vi.fn().mockResolvedValue({ ok: true }), update: vi.fn() },
      auth: { test: vi.fn().mockResolvedValue({ user_id: 'U0BMBEJTBMJ' }) },
    } as unknown as WebClient,
    chatProvider: { sendBlocks: vi.fn() } as unknown as SlackEventsHandlerOptions['chatProvider'],
    accessGuard: null,
    workspaceProvider: { getUserById: async () => null },
    auditSink: async () => undefined,
    conversationRepository: null,
    dedupRepository: new InMemorySlackEventDedupRepository(),
    rateLimiter: null,
    pinnedFactRepository: null,
    directoryRepository: {
      findBySlackUserId: vi.fn(async () => null),
      rememberDmChannel: vi.fn(async () => undefined),
    } as never,
    pruneProbability: 0,
    knowledgeIngestion: new KnowledgeIngestionService({ archive, facts }),
  });

  return { handler, archive, facts };
}

function envelope(event: Partial<SlackMessageEvent>, id = 'Ev1') {
  return {
    type: 'event_callback' as const,
    team_id: 'TMLKC4EPP',
    event_id: id,
    event: {
      type: 'message',
      user: HUMAN,
      text: DECISION,
      channel: CHANNEL,
      channel_type: 'channel',
      ts: '1700000000.000100',
      ...event,
    } as SlackMessageEvent,
  };
}

/**
 * Le MÊME enchaînement que `slack-events.route.ts` : on admet, puis on travaille en fond.
 * Tester `handleEvent` seul mentirait — les messages de canal n'y arrivent jamais.
 */
async function deliver(handler: SlackEventsHandler, env: ReturnType<typeof envelope>) {
  const decision = await handler.accept(env as never);
  if (decision.action === 'process') await handler.handleEvent(env as never);
  else await handler.ingest(env as never);
  return decision;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ingestion des messages de canal', () => {
  it('archive un message de canal ÉCARTÉ par l’admission', async () => {
    const { handler, archive } = makeHandler();

    const decision = await deliver(handler, envelope({}));

    expect(decision.action).toBe('ignore');
    const found = await archive.search('migration');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      channelId: CHANNEL,
      slackUserId: HUMAN,
      text: DECISION,
    });
  });

  it('n’écrit RIEN pendant l’admission — le chemin des 3 secondes ne grossit pas', async () => {
    const { handler, archive } = makeHandler();

    await handler.accept(envelope({}) as never);

    expect(archive.size).toBe(0);
  });

  it('N’ARCHIVE JAMAIS un message direct', async () => {
    const { handler, archive } = makeHandler();

    await deliver(handler, envelope({ channel: 'D0PRIVE01', channel_type: 'im' }));

    expect(archive.size).toBe(0);
  });

  it('n’archive pas un salon de groupe privé entre personnes (`mpim`)', async () => {
    const { handler, archive } = makeHandler();

    await deliver(handler, envelope({ channel: 'G0GROUPE1', channel_type: 'mpim' }));

    expect(archive.size).toBe(0);
  });

  it('archive un canal privé (`group`) — le bot y a été invité', async () => {
    const { handler, archive } = makeHandler();

    await deliver(handler, envelope({ channel: 'G0PRIVE01', channel_type: 'group' }));

    expect(archive.size).toBe(1);
  });

  it('n’archive pas ses propres messages, ni ceux d’un bot', async () => {
    const { handler, archive } = makeHandler();

    await deliver(handler, envelope({ bot_id: 'B0BM9MK4G65' }, 'Ev2'));
    await deliver(handler, envelope({ subtype: 'bot_message' }, 'Ev3'));

    expect(archive.size).toBe(0);
  });

  it('n’archive pas un message sans contenu textuel', async () => {
    const { handler, archive } = makeHandler();

    await deliver(handler, envelope({ text: '   ' }, 'Ev4'));

    expect(archive.size).toBe(0);
  });

  it('est IDEMPOTENTE — un rejeu Slack ne duplique rien', async () => {
    const { handler, archive, facts } = makeHandler();

    await deliver(handler, envelope({}));
    await handler.ingest(envelope({}) as never);

    expect(archive.size).toBe(1);
    expect(facts.size).toBe(1);
  });

  it('n’échoue JAMAIS le traitement si l’archive est indisponible', async () => {
    // Une panne de l'archive ne doit pas rendre le bot muet : elle est un CONFORT de
    // connaissance, pas un point de passage. Même arbitrage que la mémoire conversationnelle.
    const { handler, archive } = makeHandler();
    vi.spyOn(archive, 'archive').mockRejectedValueOnce(new Error('turso down'));

    await expect(deliver(handler, envelope({}, 'Ev5'))).resolves.toBeDefined();
  });

  it('reste inerte quand aucune ingestion n’est câblée', async () => {
    const mastra = { getAgent: vi.fn(), getWorkflow: vi.fn() } as unknown as Mastra;
    const handler = new SlackEventsHandler('xoxb-test-token', mastra, {
      slackClient: {
        chat: { postMessage: vi.fn(), update: vi.fn() },
        auth: { test: vi.fn().mockResolvedValue({ user_id: 'U0BMBEJTBMJ' }) },
      } as unknown as WebClient,
      chatProvider: { sendBlocks: vi.fn() } as unknown as SlackEventsHandlerOptions['chatProvider'],
      accessGuard: null,
      workspaceProvider: { getUserById: async () => null },
      auditSink: async () => undefined,
      conversationRepository: null,
      dedupRepository: new InMemorySlackEventDedupRepository(),
      rateLimiter: null,
      pinnedFactRepository: null,
      directoryRepository: {
        findBySlackUserId: vi.fn(async () => null),
        rememberDmChannel: vi.fn(async () => undefined),
      } as never,
      pruneProbability: 0,
    });

    await expect(deliver(handler, envelope({}, 'Ev6'))).resolves.toBeDefined();
  });
});

/**
 * LE NIVEAU 2 — ce qui est retenu et déjà mis en forme. C'est la moitié qui change ce que
 * coûte une question : l'agent lit une ligne écrite à l'ingestion, il ne refait pas la
 * sélection pendant que quelqu'un attend.
 */
describe('distillation vers le niveau 2', () => {
  it('retient une décision, avec sa nature', async () => {
    const { handler, facts } = makeHandler();

    await deliver(handler, envelope({}));

    const found = await facts.search('migration');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'decision', channelId: CHANNEL, slackUserId: HUMAN });
  });

  it('NE retient PAS un accusé de réception — c’est tout l’intérêt du tri', async () => {
    const { handler, archive, facts } = makeHandler();

    await deliver(handler, envelope({ text: 'ok merci 👍' }, 'Ev7'));

    // Le niveau 1 le garde : il sert à retrouver ce qui a été supprimé, pas à répondre.
    expect(archive.size).toBe(1);
    expect(facts.size).toBe(0);
  });

  it('NE retient PAS un message quelconque sans signal', async () => {
    const { handler, facts } = makeHandler();

    await deliver(handler, envelope({ text: 'je passe au bureau ce matin' }, 'Ev8'));

    expect(facts.size).toBe(0);
  });
});

/**
 * LE ROUTAGE — la moitié que ce dépôt a déjà oubliée deux fois.
 *
 * Une capacité qu'aucune phrase ne joint est inaccessible, quelle qu'en soit la qualité :
 * `findEmployeeByEmail` (2026-08-10) et toute `disclosure-policy.ts` (2026-08-12) l'ont été.
 * Mesuré en production le 2026-08-20, AVANT cette bande : « Qu'est-ce qui a été décidé au sujet
 * de la sonde ? » partait au DÉFAUT, donc chez un agent sans `searchKnowledge`, qui a répondu
 * — honnêtement — qu'il ne savait pas.
 */
describe('routage vers la base de connaissance', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["Qu'est-ce qui a été décidé au sujet de la migration ?", 'knowledgeAgent'],
    ["Qu'est-ce qu'on a dit sur le déploiement ?", 'knowledgeAgent'],
    ['De quoi avez-vous parlé hier ?', 'knowledgeAgent'],
    ['Ce qui a été convenu pour jeudi ?', 'knowledgeAgent'],
    ['On avait dit jeudi, non ?', 'knowledgeAgent'],
    // ⚠️ Les non-régressions. « décision » nu a été essayé puis RETIRÉ : un test préexistant
    // l'a attrapé immédiatement sur cette phrase.
    ['je conteste cette décision', 'onboardingOrchestrator'],
    ["c'est décidé, envoie-le", 'onboardingOrchestrator'],
    ['crée un employé', 'onboardingOrchestrator'],
  ];

  it.each(cases)('« %s » → %s', (text, expected) => {
    expect(routeToAgent(text)).toBe(expected);
  });

  it('ne DÉLOGE PAS un fil en cours — « décidé » peut continuer une tâche', () => {
    expect(routeToAgent("Qu'est-ce qui a été décidé ?", 'notificationAgent')).toBe(
      'notificationAgent',
    );
  });
});

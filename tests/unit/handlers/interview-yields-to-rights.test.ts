import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WebClient } from '@slack/web-api';
import type { Mastra } from '@mastra/core';

import {
  SlackEventsHandler,
  type SlackEventsHandlerOptions,
  type SlackMessageEvent,
} from '../../../src/features/notification/infrastructure/handlers/slack-events.handler';
import { InMemorySlackEventDedupRepository } from '../../../src/features/notification/infrastructure/repositories/in-memory-slack-event-dedup.repository';
import { InMemoryConversationRepository } from '../../../src/features/conversation/infrastructure/repositories/in-memory-conversation.repository';
import { InMemoryPinnedFactRepository } from '../../../src/features/conversation/infrastructure/repositories/in-memory-pinned-fact.repository';
import { INTERVIEW_QUESTION_DAILY } from '../../../src/features/onboarding/domain/services/interview-chat';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * L'ENTRETIEN CÈDE LE PAS AUX DROITS — 2026-08-19
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `captureInterviewAnswer` accepte presque n'importe quel texte, et c'est sa nature : on
 * demande à quelqu'un de décrire son métier avec ses mots, on ne peut pas le contraindre.
 * Conséquence, tant qu'une question d'entretien était en attente :
 *
 *   « oublie ce que je t'ai dit » → l'effacement N'AVAIT PAS LIEU, et la phrase était
 *   enregistrée comme la description du métier de la personne — champ imprimé dans un
 *   document à son nom, sous « Ton quotidien ».
 *
 * Deux fautes en une : un droit non exercé, et une donnée fausse écrite sous l'identité de
 * quelqu'un. Le commentaire de `handleMessage` affirmait pourtant déjà « effacer ses données
 * reste prioritaire sur répondre à une question d'accueil » : le code disait l'inverse de sa
 * propre documentation.
 */

const HUMAN = 'U0BJBDGTJUD';
const CHANNEL = 'D0MOCKDM01';
const CONVERSATION_ID = CHANNEL;

let slack: {
  chat: { postMessage: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  auth: { test: ReturnType<typeof vi.fn> };
};
let getAgent: ReturnType<typeof vi.fn>;
let conversation: InMemoryConversationRepository;
let interview: { upsert: ReturnType<typeof vi.fn>; findByEmployeeId: ReturnType<typeof vi.fn> };
let directory: { findBySlackUserId: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };

function makeHandler() {
  slack = {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1700000000.000900' }),
      update: vi.fn().mockResolvedValue({ ok: true }),
    },
    auth: { test: vi.fn().mockResolvedValue({ user_id: 'U0BMBEJTBMJ' }) },
  };
  // Un agent qui LÈVE : si le message fuit vers le modèle, le test échoue bruyamment plutôt
  // que de valider en silence une dépense sur un budget de ≈ 19 messages par jour.
  getAgent = vi.fn(() => {
    throw new Error('Le modèle ne doit JAMAIS être appelé sur ce chemin');
  });
  conversation = new InMemoryConversationRepository();
  interview = { upsert: vi.fn().mockResolvedValue(undefined), findByEmployeeId: vi.fn() };
  directory = {
    findBySlackUserId: vi
      .fn()
      .mockResolvedValue({
        slackUserId: HUMAN,
        realName: 'Karyl',
        displayName: 'Karyl',
        email: 'karyl@kisso.com',
      }),
    upsert: vi.fn().mockResolvedValue(undefined),
  };

  return new SlackEventsHandler('xoxb-test-token', { getAgent } as unknown as Mastra, {
    slackClient: slack as unknown as WebClient,
    conversationRepository: conversation,
    pinnedFactRepository: new InMemoryPinnedFactRepository(),
    dedupRepository: new InMemorySlackEventDedupRepository(),
    interviewRepository: interview as unknown as SlackEventsHandlerOptions['interviewRepository'],
    // ⚠️ SIX dépendances à neutraliser, et non quatre comme le dit encore `CLAUDE.md`. Les
    // deux oubliées sont celles qui coûtent le plus cher, et elles expliquent les faux
    // échecs de la suite observés deux fois aujourd'hui :
    //
    //   • `directoryRepository` — sans lui, `getDirectoryRepo()` fabrique un
    //     `DrizzleDirectoryRepository` AWAITÉ sur le chemin nominal : ≈ 250 ms de SQLite par
    //     message, 2 s au premier.
    //   • `accessGuard` — sans lui, la frontière construit un `SlackMemberSource` qui appelle
    //     RÉELLEMENT `users.info` avec le jeton de test : ≈ 3 s d'attente réseau, mesurées.
    //
    // Un test à quelques centaines de millisecondes du délai de 5 s bascule en rouge dès que
    // la machine est chargée, et le rouge ne désigne alors pas sa cause.
    //
    // ⚠️ `directoryRepository: null` est PIRE que l'absence : l'identité retombe sur le même
    // `users.info` réseau. Il faut une doublure qui RÉPOND, pas un trou.
    directoryRepository: directory as unknown as SlackEventsHandlerOptions['directoryRepository'],
    accessGuard: null,
    // ⚠️ HUITIÈME dépendance à neutraliser, recensée le 2026-08-19 — et la plus coûteuse
    // restante. `handleMessage` AWAIT l'identité du demandeur avant les court-circuits
    // agissants ; sans cette ligne, `resolveRequesterIdentity` retombe sur
    // `SlackWorkspaceService` et un `users.info` part RÉELLEMENT vers slack.com avec le jeton
    // de test — 0,7 à 1,7 s PAR TEST, le cache étant un LRU par instance et chaque test
    // reconstruisant le handler. C'est ce qui faisait rougir un run sur trois, toujours par
    // `Timeout 5000ms`, jamais par une assertion.
    workspaceProvider: { getUserById: async () => null },
    // ⚠️ Le journal d'audit ouvre `data/kisso.db` par défaut : c'était la DERNIÈRE dépendance
    // non neutralisée de ces tests, ≈ 250 ms par message et, sous contention, des pointes qui
    // franchissent le délai de 5 s de Vitest.
    auditSink: async () => undefined,
    rateLimiter: null,
    pruneProbability: 0,
  });
}

const dm = (text: string, ts = '1700000000.000200'): SlackMessageEvent => ({
  type: 'message',
  user: HUMAN,
  text,
  channel: CHANNEL,
  channel_type: 'im',
  ts,
});

/** Met le fil dans l'état « une question d'entretien attend sa réponse ». */
async function askTheQuestion() {
  await conversation.append({
    conversationId: CONVERSATION_ID,
    role: 'assistant',
    content: INTERVIEW_QUESTION_DAILY,
    agentId: 'onboardingOrchestrator',
    slackUserId: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('une question d’entretien en attente n’absorbe pas les court-circuits agissants', () => {
  it('EFFACE quand on le lui demande, au lieu d’enregistrer la demande comme un métier', async () => {
    const handler = makeHandler();
    await askTheQuestion();

    await handler.handleMessage(dm("oublie ce que je t'ai dit"));

    // 1. La phrase n'est pas devenue une réponse d'entretien.
    expect(interview.upsert).not.toHaveBeenCalled();
    // 2. L'effacement a bien eu lieu : le fil est vide.
    expect(
      await conversation.recentTurns(CONVERSATION_ID, { ttlMs: 3_600_000, limit: 50 }),
    ).toHaveLength(0);
    // 3. Et la question n'a pas été reposée comme si de rien n'était.
    const posted = slack.chat.postMessage.mock.calls.map((c) => (c[0] as { text: string }).text);
    expect(posted.join('\n')).not.toContain(INTERVIEW_QUESTION_DAILY);
    expect(getAgent).not.toHaveBeenCalled();
  });

  it('laisse passer une VRAIE réponse, qui contient pourtant des mots ordinaires', async () => {
    // La garde ne doit pas devenir un filtre à mots-clés : « je termine les tickets » parle
    // de travail, pas d'effacement. C'est le contre-test du précédent.
    const handler = makeHandler();
    await askTheQuestion();

    await handler.handleMessage(dm('je fais du support et je termine les tickets en cours'));

    const posted = slack.chat.postMessage.mock.calls.map((c) => (c[0] as { text: string }).text);
    expect(posted.join('\n')).toContain('travailler');
    expect(getAgent).not.toHaveBeenCalled();
  });
});

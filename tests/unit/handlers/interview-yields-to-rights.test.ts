import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  type SlackEventsHandlerOptions,
  type SlackMessageEvent,
} from '../../../src/features/notification/infrastructure/handlers/slack-events.handler';
import { InMemoryConversationRepository } from '../../../src/features/conversation/infrastructure/repositories/in-memory-conversation.repository';
import { InMemoryPinnedFactRepository } from '../../../src/features/conversation/infrastructure/repositories/in-memory-pinned-fact.repository';
import { INTERVIEW_QUESTION_DAILY } from '../../../src/features/onboarding/domain/services/interview-chat';
import { makeSlackHandler, makeThrowingMastra, type SlackMock } from '../../helpers/slack-handler';

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

let slack: SlackMock;
let getAgent: ReturnType<typeof vi.fn>;
let conversation: InMemoryConversationRepository;
let interview: { upsert: ReturnType<typeof vi.fn>; findByEmployeeId: ReturnType<typeof vi.fn> };
let directory: { findBySlackUserId: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };

function makeHandler() {
  // Un agent qui LÈVE : si le message fuit vers le modèle, le test échoue bruyamment plutôt
  // que de valider en silence une dépense sur un budget de ≈ 19 messages par jour.
  const mastra = makeThrowingMastra();
  getAgent = mastra.getAgent;
  conversation = new InMemoryConversationRepository();
  interview = { upsert: vi.fn().mockResolvedValue(undefined), findByEmployeeId: vi.fn() };
  directory = {
    findBySlackUserId: vi.fn().mockResolvedValue({
      slackUserId: HUMAN,
      realName: 'Karyl',
      displayName: 'Karyl',
      email: 'karyl@kisso.com',
    }),
    upsert: vi.fn().mockResolvedValue(undefined),
  };

  // ⚠️ Les HUIT dépendances à neutraliser — et le détail de ce que chaque oubli coûte —
  // vivent dans `tests/helpers/slack-handler.ts`. Ce fichier ne spécialise que ce dont il
  // assert l'état : la mémoire conversationnelle (dont il vérifie qu'elle est bien VIDÉE), la
  // mémoire longue que l'effacement doit emporter, l'entretien qu'il ne faut PAS écrire, et
  // un annuaire qui RÉPOND un nom.
  const { handler, slack: mock } = makeSlackHandler({
    mastra: mastra.mastra,
    conversationRepository: conversation,
    pinnedFactRepository: new InMemoryPinnedFactRepository(),
    interviewRepository: interview as unknown as SlackEventsHandlerOptions['interviewRepository'],
    directoryRepository: directory as unknown as SlackEventsHandlerOptions['directoryRepository'],
  });
  slack = mock;

  return handler;
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

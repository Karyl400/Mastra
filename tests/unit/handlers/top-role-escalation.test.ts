import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WebClient } from '@slack/web-api';
import type { Mastra } from '@mastra/core';

import {
  SlackEventsHandler,
  type SlackEventsHandlerOptions,
} from '../../../src/features/notification/infrastructure/handlers/slack-events.handler';
import { InMemorySlackEventDedupRepository } from '../../../src/features/notification/infrastructure/repositories/in-memory-slack-event-dedup.repository';
import { PROFILE_QUESTIONS } from '../../../src/features/onboarding/domain/services/profile-chat';
import { INTERVIEW_QUESTION_DAILY } from '../../../src/features/onboarding/domain/services/interview-chat';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LE CÂBLAGE, et pas seulement la décision
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `declaresTopRole` et `topRoleClaimNotice` ont leurs propres tests. Ils ne prouvent RIEN sur
 * le comportement d'un handler qui ne les appellerait pas — c'est la classe de défaut la plus
 * fréquente de ce dépôt : deux bords corrects, aucun câblage entre les deux.
 *
 * On vérifie donc ce qui PART : un message, à qui, et dans quels cas il ne part pas.
 */

const NEWCOMER = 'U0AWA00001';
const MANAGER = 'UMLK5P7CG';
const DM = 'D0MOCKDM01';
const EMPLOYEE_ID = '11111111-1111-4111-8111-111111111111';

function makeHandler(options?: { managers?: string[] }) {
  const slack = {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1700000000.000900' }),
      update: vi.fn().mockResolvedValue({ ok: true }),
    },
    auth: { test: vi.fn().mockResolvedValue({ user_id: 'U0BMBEJTBMJ' }) },
  };

  const directoryRow: Record<string, unknown> = {
    slackUserId: NEWCOMER,
    realName: 'Awa TRAORE',
    displayName: 'Awa TRAORE',
    firstName: 'Awa',
    lastName: 'TRAORE',
    email: 'awa@kissohq.com',
    employeeId: null,
    isManager: false,
  };

  const directoryRepository = {
    findBySlackUserId: vi.fn(async () => directoryRow),
    linkEmployee: vi.fn(async (_id: string, employeeId: string | null) => {
      directoryRow.employeeId = employeeId;
      return 1;
    }),
    rememberDmChannel: vi.fn(async () => undefined),
    upsertFacts: vi.fn(async () => undefined),
    findManagers: vi.fn(async () =>
      (options?.managers ?? [MANAGER]).map((slackUserId) => ({
        slackUserId,
        displayName: 'Nazer',
        realName: 'Nazer A.',
        isManager: true,
      })),
    ),
  };

  const start = vi.fn(async () => ({
    status: 'success' as const,
    result: { outcome: 'completed', employeeId: EMPLOYEE_ID, emailSent: true },
  }));

  const handler = new SlackEventsHandler(
    'xoxb-test-token',
    {
      getAgent: vi.fn(() => {
        throw new Error('Le modèle ne doit JAMAIS être appelé sur ce chemin');
      }),
      getWorkflow: vi.fn(() => ({ createRun: async () => ({ start }) })),
    } as unknown as Mastra,
    {
      slackClient: slack as unknown as WebClient,
      chatProvider: {
        sendBlocks: vi.fn().mockResolvedValue({ ts: '1' }),
      } as unknown as SlackEventsHandlerOptions['chatProvider'],
      accessGuard: null,
      workspaceProvider: { findUserById: async () => null },
      auditSink: async () => undefined,
      conversationRepository: null,
      dedupRepository: new InMemorySlackEventDedupRepository(),
      rateLimiter: null,
      pinnedFactRepository: null,
      pruneProbability: 0,
      directoryRepository:
        directoryRepository as unknown as SlackEventsHandlerOptions['directoryRepository'],
      interviewRepository: {
        findByEmployee: vi.fn(async () => null),
        save: vi.fn(async () => undefined),
        findAll: vi.fn(async () => []),
      } as unknown as SlackEventsHandlerOptions['interviewRepository'],
      profileRepository: { findByEmail: vi.fn(async () => null) },
    },
  );

  return { handler, slack, directoryRepository };
}

/** Le fil d'un arrivant dont il ne reste que le POSTE à donner. */
function historyAwaitingPosition() {
  return [
    { role: 'assistant' as const, content: PROFILE_QUESTIONS.firstName },
    { role: 'user' as const, content: 'Awa' },
    { role: 'assistant' as const, content: PROFILE_QUESTIONS.lastName },
    { role: 'user' as const, content: 'TRAORE' },
    { role: 'assistant' as const, content: PROFILE_QUESTIONS.email },
    { role: 'user' as const, content: 'awa@kissohq.com' },
    { role: 'assistant' as const, content: PROFILE_QUESTIONS.position },
  ];
}

type Probe = { maybeAdvanceOnboarding(input: Record<string, unknown>): Promise<boolean> };

async function declarePosition(handler: SlackEventsHandler, position: string) {
  await (handler as unknown as Probe).maybeAdvanceOnboarding({
    history: historyAwaitingPosition(),
    isDirectMessage: true,
    text: position,
    channel: DM,
    threadTs: undefined,
    conversationId: DM,
    user: NEWCOMER,
    employeeId: null,
  });
  // L'avertissement au manager est DÉTACHÉ (`void`) : il ne doit pas faire attendre l'arrivant.
  // On laisse donc la micro-tâche s'exécuter avant d'observer.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const postedTo = (slack: { chat: { postMessage: { mock: { calls: unknown[][] } } } }) =>
  slack.chat.postMessage.mock.calls.map((c) => (c[0] as { channel?: string }).channel);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('un poste au sommet déclaré prévient le manager', () => {
  it('envoie un DM au manager, en nommant la personne et ce qu’elle a écrit', async () => {
    const { handler, slack } = makeHandler();

    await declarePosition(handler, 'Général Manager');

    expect(postedTo(slack)).toContain(MANAGER);
    const dm = slack.chat.postMessage.mock.calls.find(
      (c) => (c[0] as { channel?: string }).channel === MANAGER,
    )![0] as { text: string };
    expect(dm.text).toContain('Awa TRAORE');
    expect(dm.text).toContain('Général Manager');
  });

  it('prévient CHAQUE manager quand il y en a plusieurs', async () => {
    const { handler, slack } = makeHandler({ managers: [MANAGER, 'UAUTRE0001'] });

    await declarePosition(handler, 'CEO');

    expect(postedTo(slack)).toContain(MANAGER);
    expect(postedTo(slack)).toContain('UAUTRE0001');
  });

  it('n’envoie RIEN sur un poste ordinaire', async () => {
    // Le filet ne doit pas se déclencher à chaque arrivée, sinon il devient du bruit — donc
    // il s'ignore, ce qui le ramène au défaut qu'il corrige.
    const { handler, slack } = makeHandler();

    await declarePosition(handler, 'Backend Developer');

    expect(postedTo(slack)).not.toContain(MANAGER);
  });

  it('n’écrit PAS à quelqu’un au sujet de lui-même', async () => {
    // Le manager qui refait son propre dossier recevrait sinon un message lui demandant s'il
    // s'approuve.
    const { handler, slack } = makeHandler({ managers: [NEWCOMER] });

    await declarePosition(handler, 'Général Manager');

    expect(postedTo(slack).filter((c) => c === NEWCOMER)).toEqual([]);
  });

  it('n’interrompt PAS l’accueil quand il n’y a aucun manager', async () => {
    // Aucun destinataire n'est un état réel — la colonne `role` naît vide. L'arrivant doit
    // recevoir la question suivante quoi qu'il arrive : le message au manager est une
    // courtoisie envers un tiers, pas une étape de son parcours.
    const { handler, slack } = makeHandler({ managers: [] });

    await declarePosition(handler, 'Général Manager');

    expect(postedTo(slack)).toContain(DM);
  });

  it('n’interrompt PAS l’accueil quand Slack refuse le DM au manager', async () => {
    const { handler, slack } = makeHandler();
    slack.chat.postMessage.mockImplementation(async (arg: { channel?: string }) => {
      if (arg.channel === MANAGER) throw new Error('channel_not_found');
      return { ok: true, ts: '1' };
    });

    await declarePosition(handler, 'Général Manager');

    expect(postedTo(slack)).toContain(DM);
  });
});

/**
 * ════════════════════════════════════════════════════════════════════════════
 * L'AUTRE MOITIÉ — le déclarant doit l'apprendre aussi
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ Prévenir le manager SANS rien dire à la personne laisse celle-ci croire que sa
 * déclaration a été enregistrée sans réserve, pendant qu'une conversation s'ouvre derrière
 * son dos. C'est la même asymétrie que `emailSent: false` sous `status: 'success'` : ce n'est
 * pas un mensonge, c'est un silence sur ce qui vient d'avoir lieu.
 */

const dmTexts = (slack: { chat: { postMessage: { mock: { calls: unknown[][] } } } }) =>
  slack.chat.postMessage.mock.calls
    .filter((c) => (c[0] as { channel?: string }).channel === DM)
    .map((c) => (c[0] as { text: string }).text);

describe('le déclarant apprend que le rôle est déjà tenu', () => {
  it('reçoit la règle et le NOM de qui porte le rôle', async () => {
    const { handler, slack } = makeHandler();

    await declarePosition(handler, 'Général Manager');

    const notice = dmTexts(slack).find((t) => /une seule personne/i.test(t));
    expect(notice).toBeDefined();
    expect(notice).toContain('Nazer');
    expect(notice).toContain('Général Manager');
  });

  it('l’apprend AVANT la question suivante — sinon la remarque arrive après coup', async () => {
    const { handler, slack } = makeHandler();

    await declarePosition(handler, 'Général Manager');

    const texts = dmTexts(slack);
    const notice = texts.findIndex((t) => /une seule personne/i.test(t));
    const question = texts.findIndex((t) => t.includes(INTERVIEW_QUESTION_DAILY));
    expect(notice).toBeGreaterThanOrEqual(0);
    expect(question).toBeGreaterThan(notice);
  });

  it('ne dit RIEN sur un poste ordinaire', async () => {
    const { handler, slack } = makeHandler();

    await declarePosition(handler, 'Backend Developer');

    expect(dmTexts(slack).some((t) => /une seule personne/i.test(t))).toBe(false);
  });

  it('ne dit rien au manager qui refait SON PROPRE dossier', async () => {
    // Il n'y a pas de conflit avec soi-même : lui annoncer la règle serait absurde.
    const { handler, slack } = makeHandler({ managers: [NEWCOMER] });

    await declarePosition(handler, 'Général Manager');

    expect(dmTexts(slack).some((t) => /une seule personne/i.test(t))).toBe(false);
  });

  it('ne dit rien quand le siège est VIDE — on ne peut pas entrer en conflit avec personne', async () => {
    // La colonne `role` naît vide : « aucun manager » est l'état de DÉPART, pas un accident.
    // Énoncer la règle sans pouvoir nommer qui la porte ni prévenir personne n'apprend rien.
    const { handler, slack } = makeHandler({ managers: [] });

    await declarePosition(handler, 'Général Manager');

    expect(dmTexts(slack).some((t) => /une seule personne/i.test(t))).toBe(false);
  });

  it('ne PROMET pas d’avoir prévenu quand Slack a refusé le DM', async () => {
    // Le pire cas serait de dire « je viens de lui écrire » après un échec : la personne
    // repartirait en croyant la situation traitée.
    const { handler, slack } = makeHandler();
    slack.chat.postMessage.mockImplementation(async (arg: { channel?: string }) => {
      if (arg.channel === MANAGER) throw new Error('channel_not_found');
      return { ok: true, ts: '1' };
    });

    await declarePosition(handler, 'Général Manager');

    const notice = dmTexts(slack).find((t) => /une seule personne/i.test(t));
    expect(notice).toBeDefined();
    expect(notice).toMatch(/pas réussi à lui écrire/i);
  });
});

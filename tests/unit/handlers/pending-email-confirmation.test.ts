import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WebClient } from '@slack/web-api';
import type { Mastra } from '@mastra/core';

import {
  SlackEventsHandler,
  type SlackEventsHandlerOptions,
  type SlackMessageEvent,
} from '../../../src/features/notification/infrastructure/handlers/slack-events.handler';
import { InMemorySlackEventDedupRepository } from '../../../src/features/notification/infrastructure/repositories/in-memory-slack-event-dedup.repository';
import { InMemoryPendingInterviewEmailRepository } from '../../../src/features/recruitment/infrastructure/repositories/in-memory-pending-email.repository';
import {
  ALREADY_SETTLED_REPLY,
  CANCELLED_REPLY,
  NOT_YOURS_REPLY,
  SEND_FAILED_REPLY,
} from '../../../src/features/recruitment/application/services/confirm-pending-email';
import { PROFILE_QUESTIONS } from '../../../src/features/onboarding/domain/services/profile-chat';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LE « OUI » CONVERSATIONNEL — ce qui a remplacé le bouton « Envoyer »
 * ════════════════════════════════════════════════════════════════════════════
 *
 * L'invitation d'entretien est le SEUL acte irréversible de ce produit. Ces tests portent
 * donc moins sur le chemin nominal que sur ce qui NE doit jamais partir :
 *
 *   • un « oui » d'un témoin qui n'a rien préparé ;
 *   • un « oui » destiné à une question d'accueil en attente ;
 *   • un second « oui » sur une préparation déjà tranchée ;
 *   • un « oui » après une panne de transport, qui ne doit pas prétendre avoir envoyé.
 *
 * Et une propriété qui n'est pas une garde mais une DEMANDE explicite : un changement de
 * sujet ne perd pas l'email — on répond au nouveau sujet ET on rappelle l'attente.
 */

const HUMAN = 'U0BJBDGTJUD';
const WITNESS = 'U0WITNESS01';
const DM = 'D0MOCKDM01';
const CANDIDATE = 'jean@exemple.com';

/** Deux jours dans le futur : les bornes de `parseInterviewSchedule` sont réelles. */
function futureIso(): string {
  return new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
}

function makeHandler(options?: {
  lastAssistant?: string;
  sendEmail?: (to: string, subject: string, body: string) => Promise<unknown>;
  requesterUserId?: string;
  startsAt?: string;
  seed?: boolean;
  agentText?: string;
}) {
  const slack = {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1700000000.000900' }),
      update: vi.fn().mockResolvedValue({ ok: true }),
    },
    auth: { test: vi.fn().mockResolvedValue({ user_id: 'U0BMBEJTBMJ' }) },
  };

  const pending = new InMemoryPendingInterviewEmailRepository();
  if (options?.seed !== false) {
    void pending.save({
      conversationId: DM,
      requesterUserId: options?.requesterUserId ?? HUMAN,
      to: CANDIDATE,
      candidateName: 'Jean DUPONT',
      startsAt: options?.startsAt ?? futureIso(),
      position: 'Backend Developer',
      location: null,
      replyTo: null,
      createdAt: new Date(),
    });
  }

  const sendEmail = vi.fn(options?.sendEmail ?? (async () => ({ ok: true })));

  const conversationRepository = {
    append: vi.fn(async (turn: unknown) => turn),
    recentTurns: vi.fn(async () =>
      options?.lastAssistant
        ? [
            {
              id: '1',
              conversationId: DM,
              role: 'assistant',
              content: options.lastAssistant,
              agentId: 'onboardingOrchestrator',
              slackUserId: null,
              createdAt: new Date(),
            },
          ]
        : [],
    ),
    prune: vi.fn(async () => 0),
    forget: vi.fn(async () => 0),
  };

  const handler = new SlackEventsHandler(
    'xoxb-test-token',
    {
      getAgent: vi.fn(() => {
        if (options?.agentText === undefined) {
          throw new Error('Le modèle ne doit JAMAIS être appelé sur ce chemin');
        }
        return { generate: async () => ({ text: options.agentText }) };
      }),
    } as unknown as Mastra,
    {
      slackClient: slack as unknown as WebClient,
      chatProvider: {
        sendBlocks: vi.fn().mockResolvedValue({ ts: '1' }),
      } as unknown as SlackEventsHandlerOptions['chatProvider'],
      accessGuard: null,
      workspaceProvider: { getUserById: async () => null },
      auditSink: async () => undefined,
      conversationRepository:
        conversationRepository as unknown as SlackEventsHandlerOptions['conversationRepository'],
      dedupRepository: new InMemorySlackEventDedupRepository(),
      rateLimiter: null,
      pinnedFactRepository: null,
      directoryRepository: {
        findBySlackUserId: vi.fn(async (id: string) => ({
          slackUserId: id,
          realName: 'Karyl SOUMAILA',
          displayName: 'Karyl SOUMAILA',
          firstName: 'Karyl',
          lastName: 'SOUMAILA',
          email: 'karyl@kisso.com',
          employeeId: null,
        })),
        rememberDmChannel: vi.fn(async () => undefined),
        upsertFacts: vi.fn(async () => undefined),
        linkEmployee: vi.fn(async () => 1),
      } as unknown as SlackEventsHandlerOptions['directoryRepository'],
      pendingEmailRepository: pending,
      sendEmail,
      pruneProbability: 0,
    },
  );

  return { handler, slack, pending, sendEmail };
}

function dm(text: string, user = HUMAN, ts = '1700000000.000200'): SlackMessageEvent {
  return { type: 'message', user, text, channel: DM, channel_type: 'im', ts };
}

const postedTexts = (slack: { chat: { postMessage: { mock: { calls: unknown[][] } } } }) =>
  slack.chat.postMessage.mock.calls.map((c) => String((c[0] as { text?: string })?.text ?? ''));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('« oui » envoie, une seule fois', () => {
  it('envoie l’email et le dit — sans jamais appeler le modèle', async () => {
    const { handler, slack, sendEmail, pending } = makeHandler();

    await handler.handleMessage(dm('oui'));

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0]?.[0]).toBe(CANDIDATE);
    expect(postedTexts(slack)[0]).toContain('C’est envoyé');
    // La préparation est CONSOMMÉE : plus rien n'attend, donc plus rien ne peut repartir.
    expect(await pending.find(DM)).toBeNull();
  });

  it('un SECOND « oui » n’envoie rien', async () => {
    const { handler, slack, sendEmail } = makeHandler();

    await handler.handleMessage(dm('oui', HUMAN, '1700000000.000200'));
    await handler.handleMessage(dm('oui', HUMAN, '1700000000.000300'));

    expect(sendEmail).toHaveBeenCalledTimes(1);
    // Le second « oui » ne trouve plus rien en attente : il repart chez l'agent, qui lève ici.
    expect(postedTexts(slack)[1] ?? '').not.toContain('C’est envoyé');
  });
});

describe('« non » annule, et rien ne part', () => {
  it('efface la préparation et ne prétend jamais avoir envoyé', async () => {
    const { handler, slack, sendEmail, pending } = makeHandler();

    await handler.handleMessage(dm('non'));

    expect(sendEmail).not.toHaveBeenCalled();
    expect(postedTexts(slack)[0]).toBe(CANCELLED_REPLY);
    expect(await pending.find(DM)).toBeNull();
  });
});

describe('un TÉMOIN ne peut pas déclencher l’envoi', () => {
  it('refuse, et laisse la préparation intacte pour son auteur', async () => {
    const { handler, slack, sendEmail, pending } = makeHandler();

    await handler.handleMessage(dm('oui', WITNESS));

    expect(sendEmail).not.toHaveBeenCalled();
    expect(postedTexts(slack)[0]).toBe(NOT_YOURS_REPLY);
    // ⚠️ Le refus ne DÉTRUIT pas : un contrôle d'accès qui efface deviendrait un déni de
    // service — la même règle que celle écrite pour la carte à boutons.
    expect(await pending.find(DM)).not.toBeNull();
  });
});

describe('une panne de transport ne ment pas, et rend la prise', () => {
  it('dit que rien n’est parti et garde la préparation pour un nouvel essai', async () => {
    const { handler, slack, pending } = makeHandler({
      sendEmail: async () => {
        throw new Error('SMTP timeout');
      },
    });

    await handler.handleMessage(dm('oui'));

    expect(postedTexts(slack)[0]).toBe(SEND_FAILED_REPLY);
    expect(await pending.find(DM)).not.toBeNull();
  });
});

describe('une date devenue passée n’envoie rien', () => {
  it('le dit, et efface une préparation qui ne peut plus servir', async () => {
    const { handler, slack, sendEmail, pending } = makeHandler({
      startsAt: new Date(Date.now() - 60_000).toISOString(),
    });

    await handler.handleMessage(dm('oui'));

    expect(sendEmail).not.toHaveBeenCalled();
    expect(postedTexts(slack)[0]).toContain('n’est plus valide');
    expect(await pending.find(DM)).toBeNull();
  });
});

describe('LA QUESTION D’ACCUEIL PRIME sur l’email en attente', () => {
  it('« oui » n’envoie RIEN quand une question de profil attend', async () => {
    // ⚠️ L'asymétrie commande : capturer « oui » comme un prénom se corrige d'un message,
    // envoyer une invitation à un candidat ne se corrige pas.
    const { handler, sendEmail } = makeHandler({
      lastAssistant: PROFILE_QUESTIONS.firstName as string,
    });

    await handler.handleMessage(dm('oui'));

    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('un changement de sujet garde l’email en suspens', () => {
  it('ne consomme rien et n’efface rien', async () => {
    const { handler, sendEmail, pending } = makeHandler();

    // Le modèle lève dans ce test : on vérifie que le chemin n'a rien tranché AVANT lui.
    await handler.handleMessage(dm('Génère-moi le guide d’accueil en PDF'));

    expect(sendEmail).not.toHaveBeenCalled();
    expect(await pending.find(DM)).not.toBeNull();
  });
});

describe('déjà tranché', () => {
  it('« non » sur une préparation absente ne prétend pas annuler quelque chose', async () => {
    const { handler, slack } = makeHandler({ seed: false });
    // Sans préparation, le message repart chez l'agent : aucune des deux réponses de
    // confirmation ne doit apparaître.
    await handler.handleMessage(dm('non'));
    expect(postedTexts(slack)[0] ?? '').not.toBe(CANCELLED_REPLY);
    expect(postedTexts(slack)[0] ?? '').not.toBe(ALREADY_SETTLED_REPLY);
  });
});

describe('LE RAPPEL — la demande explicite du 2026-08-19', () => {
  it('accole le rappel à la réponse de l’agent, sans poster un second message', async () => {
    // « En cas de changement de sujet, faire un rappel sur l'email à envoyer et si
    // l'utilisateur veut changer de sujet, changer de sujet et garder l'email en suspens. »
    const { handler, slack, pending } = makeHandler({
      agentText: 'Voici le guide d’accueil.',
    });

    await handler.handleMessage(dm('Génère-moi le guide d’accueil en PDF'));

    // La réponse finale REMPLACE le marqueur de progression : elle passe par `chat.update`.
    const updated = slack.chat.update.mock.calls.map((c) =>
      String((c[0] as { text?: string })?.text ?? ''),
    );
    const finale = updated.at(-1) ?? '';
    expect(finale).toContain('Voici le guide');
    expect(finale).toContain('Jean DUPONT');
    // Le sujet a bien changé ET l'email attend toujours.
    expect(await pending.find(DM)).not.toBeNull();
  });
});

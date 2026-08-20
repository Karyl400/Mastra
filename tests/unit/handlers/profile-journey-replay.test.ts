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
import { PROFILE_QUESTIONS } from '../../../src/features/onboarding/domain/services/profile-chat';
import { INTERVIEW_QUESTION_DAILY } from '../../../src/features/onboarding/domain/services/interview-chat';

/**
 * LE PARCOURS DE COMPLÉTION DE PROFIL, REJOUÉ DE BOUT EN BOUT.
 *
 * ⚠️ Ce fichier diffère de `profile-chat-persistence.test.ts` sur un point qui est TOUT
 * l'intérêt : celui-ci FABRIQUE l'historique et pousse la machine à états à la main ; ici on
 * passe par `handleMessage` avec une vraie mémoire conversationnelle, et l'état n'est porté
 * que par ce que le handler a réellement écrit au tour précédent.
 *
 * C'est la différence entre vérifier que la machine à états est correcte — elle l'est, mesuré
 * — et vérifier que le PARCOURS fonctionne. Les deux dernières pannes de ce dépôt vivaient
 * exactement dans cet écart : `slack_directory.employee_id` que rien n'écrivait, et la
 * question d'accueil absorbée par un court-circuit.
 *
 * Aucun appel de modèle n'est autorisé : `getAgent` lève. Le parcours coûte ZÉRO token, et
 * s'il en coûtait un ce test le dirait.
 */

const HUMAN = 'U0MARCEL01';
const DM = 'D0MARCEL01';
const EMPLOYEE_ID = 'e7a1b2c3-0000-4000-8000-0000000000aa';

/**
 * ⚠️ L'annuaire Slack CONNAÎT déjà le prénom et le nom (c'est l'état réel d'un arrivant :
 * Slack les tient). Depuis le 2026-08-20, le parcours ne redemande plus ce qu'il sait —
 * il n'y a donc que DEUX questions, et la première est l'email.
 *
 * Le `title` de l'annuaire n'est délibérément PAS repris : le relevé de production montre
 * qu'il ment (« Product Manager » y désigne quelqu'un qui n'est pas le manager), et c'est le
 * seul des quatre champs imprimé dans les documents.
 */
const REPONSES: readonly [string, string][] = [
  ['<mailto:marcel.testeur@example.com|marcel.testeur@example.com>', 'email'],
  ['Backend Developer', 'position'],
];

function makeHandler() {
  const posted: string[] = [];
  const slack = {
    chat: {
      postMessage: vi.fn(async (args: { text?: string }) => {
        posted.push(args.text ?? '');
        return { ok: true, ts: `17000000.${posted.length}` };
      }),
      update: vi.fn().mockResolvedValue({ ok: true }),
    },
    auth: { test: vi.fn().mockResolvedValue({ user_id: 'U0BMBEJTBMJ' }) },
  };

  const directoryRow: Record<string, unknown> = {
    slackUserId: HUMAN,
    realName: 'Marcel TESTEUR',
    displayName: 'Marcel TESTEUR',
    firstName: 'Marcel',
    lastName: 'TESTEUR',
    email: null,
    employeeId: null,
    isBot: false,
    isDeleted: false,
    isRestricted: false,
    isUltraRestricted: false,
    role: 'employee',
  };

  const directoryRepository = {
    findBySlackUserId: vi.fn(async () => directoryRow),
    linkEmployee: vi.fn(async (_s: string, employeeId: string | null) => {
      directoryRow.employeeId = employeeId;
      return 1;
    }),
    rememberDmChannel: vi.fn(async () => undefined),
    upsertFacts: vi.fn(async () => undefined),
    hasManager: vi.fn(async () => false),
    findManagers: vi.fn(async () => []),
  };

  const saved: Array<Record<string, unknown>> = [];
  const interviewRepository = {
    findByEmployee: vi.fn(async () => null),
    save: vi.fn(async (entry: Record<string, unknown>) => {
      saved.push(entry);
    }),
    listAll: vi.fn(async () => []),
  };

  const start = vi.fn(async () => ({
    status: 'success' as const,
    result: { outcome: 'completed', employeeId: EMPLOYEE_ID, emailSent: true },
  }));

  const mastra = {
    getAgent: vi.fn(() => {
      throw new Error('AUCUN appel de modèle ne doit avoir lieu sur ce parcours');
    }),
    getWorkflow: vi.fn(() => ({ createRun: async () => ({ start }) })),
  } as unknown as Mastra;

  const handler = new SlackEventsHandler('xoxb-test-token', mastra, {
    slackClient: slack as unknown as WebClient,
    chatProvider: {
      sendBlocks: vi.fn().mockResolvedValue({ ts: '1' }),
    } as unknown as SlackEventsHandlerOptions['chatProvider'],
    accessGuard: null,
    workspaceProvider: { getUserById: async () => null },
    auditSink: async () => undefined,
    conversationRepository: new InMemoryConversationRepository(),
    dedupRepository: new InMemorySlackEventDedupRepository(),
    rateLimiter: null,
    pinnedFactRepository: null,
    pruneProbability: 0,
    directoryRepository:
      directoryRepository as unknown as SlackEventsHandlerOptions['directoryRepository'],
    interviewRepository:
      interviewRepository as unknown as SlackEventsHandlerOptions['interviewRepository'],
    profileRepository: { findByEmail: vi.fn(async () => null) },
  });

  return { handler, posted, directoryRepository, saved, start };
}

function dm(text: string, n: number): SlackMessageEvent {
  return {
    type: 'message',
    user: HUMAN,
    text,
    channel: DM,
    channel_type: 'im',
    ts: `1700000000.0000${String(n).padStart(2, '0')}`,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parcours de profil — rejoué de bout en bout', () => {
  it('pose les quatre questions dans l’ordre et enregistre le dossier', async () => {
    const { handler, posted, start } = makeHandler();

    await handler.handleMessage(dm('Je veux compléter mon profil', 1));
    expect(
      posted.at(-1),
      'la première question manquante doit être posée, pas le prénom déjà connu',
    ).toContain(PROFILE_QUESTIONS.email);

    for (const [index, [reponse, etape]] of REPONSES.entries()) {
      await handler.handleMessage(dm(reponse, index + 2));

      const suivante = REPONSES[index + 1];
      if (suivante) {
        expect(
          posted.at(-1),
          `après « ${reponse} » (${etape}), la question suivante doit venir`,
        ).toContain(PROFILE_QUESTIONS[suivante[1] as keyof typeof PROFILE_QUESTIONS]);
      }
    }

    expect(start, 'le workflow doit être lancé une fois le dossier complet').toHaveBeenCalledTimes(
      1,
    );
  });

  it('relie l’annuaire au dossier créé, et enchaîne sur l’entretien', async () => {
    const { handler, posted, directoryRepository } = makeHandler();

    await handler.handleMessage(dm('Je veux compléter mon profil', 1));
    for (const [index, [reponse]] of REPONSES.entries()) {
      await handler.handleMessage(dm(reponse, index + 2));
    }

    expect(directoryRepository.linkEmployee).toHaveBeenCalledWith(HUMAN, EMPLOYEE_ID);
    expect(posted.at(-1)).toContain(INTERVIEW_QUESTION_DAILY);
  });

  it('n’appelle JAMAIS le modèle — le parcours coûte zéro token', async () => {
    const { handler } = makeHandler();

    await handler.handleMessage(dm('Je veux compléter mon profil', 1));
    for (const [index, [reponse]] of REPONSES.entries()) {
      await expect(handler.handleMessage(dm(reponse, index + 2))).resolves.not.toThrow();
    }
  });
});

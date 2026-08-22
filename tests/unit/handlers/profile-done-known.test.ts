import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mastra } from '@mastra/core';

import {
  SlackEventsHandler,
  type SlackEventsHandlerOptions,
} from '../../../src/features/notification/infrastructure/handlers/slack-events.handler';
import { makeSlackHandler } from '../../helpers/slack-handler';
import { PROFILE_QUESTIONS } from '../../../src/features/onboarding/domain/services/profile-chat';
import type { ProfileSnapshot } from '../../../src/features/onboarding/domain/services/profile-completion';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * « J'AI FINI » AVEC DES TROUS — ne redemander QUE ce qui manque
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ Le verdict ne lisait que `employees`, alors que le parcours conversationnel part de
 * `knownProfileAnswers` — annuaire PLUS dossier — et fusionne l'historique du fil. Résultat
 * mesurable : quelqu'un qui vient d'écrire son prénom, puis dit « c'est fait », se l'entendait
 * redemander. Deux machines à états qui suivent la même règle sans la partager divergent, et
 * c'est celle qu'on a oubliée qui fait le mauvais travail.
 */

const USER = 'U0AWA00001';
const DM = 'D0MOCKDM01';
const EMPLOYEE_ID = '11111111-1111-4111-8111-111111111111';

function makeHandler(options?: {
  directory?: Record<string, unknown> | null;
  record?: ProfileSnapshot | null;
}) {
  const directoryRow = options?.directory ?? {
    slackUserId: USER,
    realName: 'Awa TRAORE',
    displayName: 'Awa TRAORE',
    firstName: 'Awa',
    lastName: 'TRAORE',
    email: 'awa@kissohq.com',
    employeeId: null,
    isManager: false,
  };

  const start = vi.fn(async () => ({
    status: 'success' as const,
    result: { outcome: 'completed', employeeId: EMPLOYEE_ID, emailSent: true },
  }));

  // Les HUIT dépendances neutralisables le sont par la fabrique partagée (voir son en-tête).
  // Ce fichier spécialise les deux SOURCES que le verdict doit réconcilier — l'annuaire et le
  // dossier —, plus l'entretien vers lequel un dossier complet enchaîne.
  const { handler, slack } = makeSlackHandler({
    mastra: {
      getAgent: vi.fn(() => {
        throw new Error('Le modèle ne doit JAMAIS être appelé sur ce chemin');
      }),
      getWorkflow: vi.fn(() => ({ createRun: async () => ({ start }) })),
    } as unknown as Mastra,
    directoryRepository: {
      findBySlackUserId: vi.fn(async () => directoryRow),
      linkEmployee: vi.fn(async () => 1),
      rememberDmChannel: vi.fn(async () => undefined),
      upsertFacts: vi.fn(async () => undefined),
      findManagers: vi.fn(async () => []),
    } as unknown as SlackEventsHandlerOptions['directoryRepository'],
    interviewRepository: {
      findByEmployee: vi.fn(async () => null),
      save: vi.fn(async () => undefined),
      listAll: vi.fn(async () => []),
    } as unknown as SlackEventsHandlerOptions['interviewRepository'],
    profileRepository: {
      findByEmail: vi.fn(async () => options?.record ?? null),
      findById: vi.fn(async () => options?.record ?? null),
    },
  });

  return { handler, slack, start };
}

type Probe = { maybeAdvanceOnboarding(input: Record<string, unknown>): Promise<boolean> };

async function sayDone(
  handler: SlackEventsHandler,
  history: Array<{ role: string; content: string }> = [],
) {
  await (handler as unknown as Probe).maybeAdvanceOnboarding({
    history,
    isDirectMessage: true,
    text: "j'ai fini",
    channel: DM,
    threadTs: undefined,
    conversationId: DM,
    user: USER,
    employeeId: null,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const texts = (slack: { chat: { postMessage: { mock: { calls: unknown[][] } } } }) =>
  slack.chat.postMessage.mock.calls.map((c) => (c[0] as { text: string }).text);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('« j’ai fini » ne redemande pas ce que l’annuaire sait déjà', () => {
  it('demande le POSTE, pas le prénom, quand l’annuaire porte prénom, nom et email', async () => {
    const { handler, slack } = makeHandler();

    await sayDone(handler);

    const reply = texts(slack).join('\n');
    expect(reply).toContain(PROFILE_QUESTIONS.position);
    expect(reply).not.toContain(PROFILE_QUESTIONS.firstName);
  });

  it('ne nomme comme manquant que le poste', async () => {
    const { handler, slack } = makeHandler();

    await sayDone(handler);

    const reply = texts(slack).join('\n');
    expect(reply).toContain('l’intitulé de ton poste');
    expect(reply).not.toContain('ton prénom');
  });

  it('⚠️ ne crée AUCUN dossier tant que la personne n’a pas écrit son poste', async () => {
    // L'annuaire donne prénom, nom et email — jamais le poste : `answersFromDirectory` ne
    // mappe délibérément pas `title`, qui est un champ déclaratif édité par son porteur.
    // Un dossier fabriqué depuis l'annuaire seul porterait un poste que personne n'a validé.
    const { handler, start } = makeHandler();

    await sayDone(handler);

    expect(start).not.toHaveBeenCalled();
  });

  it('tient compte de l’HISTORIQUE du fil, pas seulement de l’annuaire', async () => {
    // L'annuaire ne sait rien : tout ce qu'on a, la personne vient de l'écrire.
    const { handler, slack } = makeHandler({
      directory: {
        slackUserId: USER,
        realName: '',
        displayName: '',
        firstName: null,
        lastName: null,
        email: null,
        employeeId: null,
        isManager: false,
      },
    });

    await sayDone(handler, [
      { role: 'assistant', content: PROFILE_QUESTIONS.firstName },
      { role: 'user', content: 'Awa' },
      { role: 'assistant', content: PROFILE_QUESTIONS.lastName },
      { role: 'user', content: 'TRAORE' },
    ]);

    const reply = texts(slack).join('\n');
    expect(reply).toContain(PROFILE_QUESTIONS.email);
    expect(reply).not.toContain(PROFILE_QUESTIONS.firstName);
  });

  it('⚠️ TIENT LA PROMESSE de PROFILE_CHAT_SAVE_FAILED : il RÉESSAIE l’enregistrement', async () => {
    // Ce texte dit mot pour mot « redis-moi "j'ai fini" dans un instant et je réessaie ».
    // Tant que « j'ai fini » ne faisait que relire la base, la promesse était creuse.
    const { handler, start, slack } = makeHandler();

    await sayDone(handler, [
      { role: 'assistant', content: PROFILE_QUESTIONS.position },
      { role: 'user', content: 'Backend Developer' },
    ]);

    expect(start).toHaveBeenCalledTimes(1);
    expect(texts(slack).join('\n')).not.toContain(PROFILE_QUESTIONS.firstName);
  });

  it('⚠️ un dossier EXISTANT et partiel n’est jamais réenregistré — ce serait un doublon', async () => {
    // Le réenregistrement ne vaut que pour la promesse de `PROFILE_CHAT_SAVE_FAILED`, donc
    // pour un dossier ABSENT. Une ligne existante mais incomplète repasserait par le workflow
    // de création, et `employees.email` est UNIQUE : le symptôme serait un conflit d'adresse
    // sur son propre dossier.
    const { handler, start, slack } = makeHandler({
      record: {
        firstName: 'Awa',
        lastName: 'TRAORE',
        email: 'awa@kissohq.com',
        position: '',
      },
    });

    await sayDone(handler, [
      { role: 'assistant', content: PROFILE_QUESTIONS.position },
      { role: 'user', content: 'Backend Developer' },
    ]);

    expect(start).not.toHaveBeenCalled();
    expect(texts(slack).join('\n')).toContain(PROFILE_QUESTIONS.position);
  });

  it('un dossier RÉELLEMENT complet passe à l’entretien — le verdict n’a pas bougé', async () => {
    const { handler, slack } = makeHandler({
      record: {
        firstName: 'Awa',
        lastName: 'TRAORE',
        email: 'awa@kissohq.com',
        position: 'Backend Developer',
      },
    });

    await sayDone(handler);

    expect(texts(slack).join('\n')).toMatch(/dossier est complet/i);
  });
});

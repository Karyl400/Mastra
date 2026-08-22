import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mastra } from '@mastra/core';

import {
  SlackEventsHandler,
  type SlackEventsHandlerOptions,
} from '../../../src/features/notification/infrastructure/handlers/slack-events.handler';
import { makeSlackHandler } from '../../helpers/slack-handler';
import { PROFILE_QUESTIONS } from '../../../src/features/onboarding/domain/services/profile-chat';
import { INTERVIEW_QUESTION_DAILY } from '../../../src/features/onboarding/domain/services/interview-chat';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LA CAUSE RACINE — `slack_directory.employee_id` n'était jamais écrite
 * ════════════════════════════════════════════════════════════════════════════
 *
 * L'entretien répondait « Noté. » puis « j'y mettrai ce que tu viens de me dire », et
 * n'enregistrait RIEN. `persistInterviewAnswer` sortait en silence, sans log, dès que
 * `input.employeeId` manquait — et il manquait toujours pour quiconque avait été créé par le
 * chemin conversationnel :
 *
 *   • `input.employeeId` vient de `resolveRequesterIdentity` → `slack_directory.employee_id` ;
 *   • le seul écrivain de cette colonne est `linkEmployee` ;
 *   • son seul appelant est `directory-sync.service.ts`, dont le seul point d'entrée est le
 *     script manuel `scripts/sync-slack-directory.mts` ;
 *   • `submitProfile` créait le dossier et ne reliait rien — l'identifiant était pourtant
 *     FOURNI au crochet `onRecordReady`, puis jeté.
 *
 * ⚠️ Le test de production du 2026-08-19 n'a rien vu parce que la ligne d'annuaire de la
 * personne qui testait avait été reliée par une exécution passée du script. La feature
 * fonctionnait exactement pour les gens reliés à la main.
 *
 * Même cause, second effet : `canReadPersonRecord` accorde « son propre dossier, toujours »
 * sur ce champ. Poser `AUTHZ_ENFORCE` aurait coupé chacun de SON PROPRE dossier.
 */

const HUMAN = 'U0BJBDGTJUD';
const DM = 'D0MOCKDM01';
const EMPLOYEE_ID = 'e7a1b2c3-0000-4000-8000-000000000001';

function makeHandler() {
  const linkEmployee = vi.fn().mockResolvedValue(undefined);
  /** L'annuaire NE PORTE PAS d'`employeeId` au départ — c'est l'état réel d'un arrivant. */
  const directoryRow: Record<string, unknown> = {
    slackUserId: HUMAN,
    realName: 'Karyl SOUMAILA',
    displayName: 'Karyl SOUMAILA',
    firstName: 'Karyl',
    lastName: 'SOUMAILA',
    email: 'karyl@kisso.com',
    employeeId: null,
  };

  const directoryRepository = {
    findBySlackUserId: vi.fn(async () => directoryRow),
    // Le vrai dépôt écrit la colonne ; la doublure reflète cette écriture pour que le tour
    // SUIVANT voie l'identifiant, comme en production.
    linkEmployee: vi.fn(async (slackUserId: string, employeeId: string | null) => {
      directoryRow.employeeId = employeeId;
      return linkEmployee(slackUserId, employeeId);
    }),
    rememberDmChannel: vi.fn(async () => undefined),
    upsertFacts: vi.fn(async () => undefined),
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
      throw new Error('Le modèle ne doit JAMAIS être appelé sur ce chemin');
    }),
    getWorkflow: vi.fn(() => ({ createRun: async () => ({ start }) })),
  } as unknown as Mastra;

  // Les HUIT dépendances neutralisables le sont par la fabrique partagée (voir son en-tête).
  // Ce fichier spécialise l'annuaire — dont l'écriture de `employee_id` EST la cause racine
  // qu'il verrouille —, l'entretien qu'on doit voir enregistrer, et le dépôt de profil.
  const { handler, slack } = makeSlackHandler({
    mastra,
    directoryRepository:
      directoryRepository as unknown as SlackEventsHandlerOptions['directoryRepository'],
    interviewRepository:
      interviewRepository as unknown as SlackEventsHandlerOptions['interviewRepository'],
    profileRepository: { findByEmail: vi.fn(async () => null) },
  });

  return { handler, slack, directoryRepository, interviewRepository, saved, start };
}

/** Le fil, tel que la machine à états le relit : le dernier tour `assistant` porte l'état. */
function historyEndingWith(question: string) {
  return [{ role: 'assistant' as const, content: question }];
}

/**
 * Le fil d'un arrivant qui n'a AUCUN dossier : les trois premières questions ont été posées
 * et répondues, la quatrième attend. `collectProfileAnswers` apparie les paires ; c'est
 * exactement ce que la production relit.
 */
function historyOfCompletedProfile() {
  return [
    { role: 'assistant' as const, content: PROFILE_QUESTIONS.firstName as string },
    { role: 'user' as const, content: 'Karyl' },
    { role: 'assistant' as const, content: PROFILE_QUESTIONS.lastName as string },
    { role: 'user' as const, content: 'SOUMAILA' },
    { role: 'assistant' as const, content: PROFILE_QUESTIONS.email as string },
    { role: 'user' as const, content: 'karyl@kisso.com' },
    { role: 'assistant' as const, content: PROFILE_QUESTIONS.position as string },
  ];
}

type Probe = {
  maybeAdvanceOnboarding(input: Record<string, unknown>): Promise<boolean>;
};

/** Pousse un pas de machine à états avec un fil fabriqué, sans passer par la mémoire. */
async function step(
  handler: SlackEventsHandler,
  history: ReturnType<typeof historyEndingWith> | ReturnType<typeof historyOfCompletedProfile>,
  answer: string,
  employeeId: string | null,
) {
  return await (handler as unknown as Probe).maybeAdvanceOnboarding({
    history,
    isDirectMessage: true,
    text: answer,
    channel: DM,
    threadTs: undefined,
    conversationId: DM,
    user: HUMAN,
    employeeId,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('la fin du dossier RELIE l’annuaire au dossier créé', () => {
  it('appelle linkEmployee avec l’identifiant que le workflow vient de créer', async () => {
    const { handler, directoryRepository, start } = makeHandler();

    // Dernière question du dossier : le poste. Les trois autres champs sont déjà connus par
    // l'annuaire, donc `collectProfileAnswers` + `answersFromRecord` complètent le socle.
    const advanced = await step(handler, historyOfCompletedProfile(), 'Backend Developer', null);

    expect(advanced).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
    expect(directoryRepository.linkEmployee).toHaveBeenCalledWith(HUMAN, EMPLOYEE_ID);
  });

  it('enchaîne sur l’entretien APRÈS avoir relié — sinon la première réponse est perdue', async () => {
    const { handler, slack, directoryRepository } = makeHandler();

    await step(handler, historyOfCompletedProfile(), 'Backend Developer', null);

    const posted = slack.chat.postMessage.mock.calls.map((c) => String(c[0]?.text ?? ''));
    const questionIndex = posted.findIndex((t) => t.includes(INTERVIEW_QUESTION_DAILY));
    expect(questionIndex).toBeGreaterThanOrEqual(0);

    // ⚠️ L'ORDRE EST LE CORRECTIF. La question de l'entretien invite la personne à répondre ;
    // sa réponse arrivera au tour SUIVANT, avec l'identité relue depuis l'annuaire. Poser la
    // question avant d'avoir relié rejouerait exactement le défaut d'un tour plus tard.
    expect(directoryRepository.linkEmployee.mock.invocationCallOrder[0]).toBeLessThan(
      slack.chat.postMessage.mock.invocationCallOrder[questionIndex]!,
    );
  });
});

describe('l’entretien ENREGISTRE réellement ce qu’on lui répond', () => {
  it('persiste la réponse du tour suivant, avec l’identifiant fraîchement relié', async () => {
    const { handler, interviewRepository, saved } = makeHandler();

    await step(handler, historyOfCompletedProfile(), 'Backend Developer', null);

    // Tour suivant : la personne répond à l'entretien. L'identité est relue de l'annuaire,
    // que le tour précédent vient de relier.
    const advanced = await step(
      handler,
      historyEndingWith(INTERVIEW_QUESTION_DAILY),
      'Je fais du support technique niveau 2',
      EMPLOYEE_ID,
    );

    expect(advanced).toBe(true);
    expect(interviewRepository.save).toHaveBeenCalledTimes(1);
    expect(saved[0]).toMatchObject({
      employeeId: EMPLOYEE_ID,
      slackUserId: HUMAN,
      dailyWork: 'Je fais du support technique niveau 2',
    });
  });

  it('ne se tait PLUS quand l’identifiant manque — l’échec devient visible', async () => {
    // Cas restant après le correctif : une personne déjà présente, jamais reliée, dont le
    // dossier a été créé avant. Le geste humain est `npm run directory:sync -- --apply`, mais
    // le produit doit le DIRE dans ses logs plutôt que de perdre la réponse en silence.
    const { handler, interviewRepository } = makeHandler();
    const { logger } = await import('../../../src/shared/logger');
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    await step(
      handler,
      historyEndingWith(INTERVIEW_QUESTION_DAILY),
      'Je fais du support technique',
      null,
    );

    expect(interviewRepository.save).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('entretien'),
      expect.objectContaining({ reason: 'missing_employee_id' }),
    );
    spy.mockRestore();
  });
});

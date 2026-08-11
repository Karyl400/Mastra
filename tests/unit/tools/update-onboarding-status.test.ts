import { describe, it, expect } from 'vitest';

import { makeUpdateOnboardingStatus } from '../../../src/features/onboarding/application/tools/update-onboarding-status';
import { InMemoryOnboardingRepository } from '../../../src/features/onboarding/infrastructure/repositories/in-memory-onboarding.repository';
import { OnboardingStatus } from '../../../src/shared/types';

/**
 * `updateOnboardingStatus` levait `NotFoundError` dès que l'employé n'avait pas
 * de ligne `onboarding_progress` — c'est-à-dire pour 100 % des employés de la
 * production, aucun n'ayant été créé par `employeeOnboardingWorkflow`.
 *
 * L'exception n'était PAS un simple échec : l'AI SDK v7 la capture et la
 * réinjecte au modèle sous forme de part `tool-error` (node_modules/ai, tool
 * execution). Le modèle, voyant « pas de suivi », en déduit qu'il lui manque une
 * étape et INVENTE la capacité correspondante — il a réellement proposé
 * « Souhaites-tu que je crée un enregistrement d'onboarding ? » puis tenté
 * d'appeler un tool `createOnboarding` qui n'existe pas. Le catch générique du
 * handler Slack n'est jamais atteint : l'utilisateur ne voit pas une erreur, il
 * voit une PROMESSE.
 *
 * Le tool rend donc un résultat structuré qui INSTRUIT le modèle, sur le modèle
 * de `find-employee-by-email.ts`.
 */

const EMPLOYEE_ID = '11111111-1111-4111-8111-111111111111';
const PROGRESS_ID = '22222222-2222-4222-8222-222222222222';

function progressRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PROGRESS_ID,
    employeeId: EMPLOYEE_ID,
    status: OnboardingStatus.NotStarted,
    currentStep: 0,
    totalSteps: 5,
    startedAt: null,
    completedAt: null,
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
    ...overrides,
  };
}

describe('updateOnboardingStatus — suivi existant', () => {
  it('met à jour le statut et rend un résultat borné', async () => {
    const repo = new InMemoryOnboardingRepository();
    await repo.save(progressRow() as never);

    const result = (await makeUpdateOnboardingStatus(repo).execute!(
      { employeeId: EMPLOYEE_ID, status: OnboardingStatus.InProgress, currentStep: 2 } as never,
      {} as never,
    )) as { updated: boolean; status: string; currentStep: number; totalSteps: number };

    expect(result.updated).toBe(true);
    expect(result.status).toBe(OnboardingStatus.InProgress);
    expect(result.currentStep).toBe(2);
    expect(result.totalSteps).toBe(5);

    const persisted = await repo.findByEmployee(EMPLOYEE_ID);
    expect(persisted?.status).toBe(OnboardingStatus.InProgress);
    expect(persisted?.startedAt).not.toBeNull();
  });

  it("n'expose aucun identifiant technique ni horodatage superflu", async () => {
    // Budget de tokens : le tool-result est réémis à chaque aller-retour.
    const repo = new InMemoryOnboardingRepository();
    await repo.save(progressRow() as never);

    const result = (await makeUpdateOnboardingStatus(repo).execute!(
      { employeeId: EMPLOYEE_ID, status: OnboardingStatus.Completed } as never,
      {} as never,
    )) as Record<string, unknown>;

    for (const champ of ['id', 'employeeId', 'createdAt', 'updatedAt']) {
      expect(result, `${champ} n'a rien à faire dans le contexte du modèle`).not.toHaveProperty(
        champ,
      );
    }
  });
});

describe('updateOnboardingStatus — suivi absent', () => {
  it('ne lève JAMAIS et rend un échec structuré', async () => {
    const repo = new InMemoryOnboardingRepository();

    const result = (await makeUpdateOnboardingStatus(repo).execute!(
      { employeeId: EMPLOYEE_ID, status: OnboardingStatus.InProgress } as never,
      {} as never,
    )) as { updated: boolean; reason: string; hint: string };

    expect(result.updated).toBe(false);
    expect(result.reason).toBe('no_onboarding_progress');
  });

  it('interdit explicitement au modèle de proposer de créer le suivi', async () => {
    // C'est LA propriété qui compte : sans elle, le modèle comble le vide en
    // inventant `createOnboarding`.
    const repo = new InMemoryOnboardingRepository();

    const result = (await makeUpdateOnboardingStatus(repo).execute!(
      { employeeId: EMPLOYEE_ID, status: OnboardingStatus.InProgress } as never,
      {} as never,
    )) as { hint: string };

    expect(result.hint).toMatch(/aucun outil/i);
    expect(result.hint).toMatch(/ne propose pas/i);
  });

  it("n'écrit rien en base", async () => {
    const repo = new InMemoryOnboardingRepository();

    await makeUpdateOnboardingStatus(repo).execute!(
      { employeeId: EMPLOYEE_ID, status: OnboardingStatus.InProgress } as never,
      {} as never,
    );

    expect(await repo.findByEmployee(EMPLOYEE_ID)).toBeNull();
  });

  it('annonce dans sa description qu il ne lève pas d exception', async () => {
    // Le modèle lit la description avant d'appeler : elle doit dire que
    // l'absence de suivi est un RÉSULTAT, pas une panne.
    const tool = makeUpdateOnboardingStatus(new InMemoryOnboardingRepository());
    expect(tool.description).toMatch(/updated=false|jamais une exception/i);
  });
});

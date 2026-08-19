import { describe, it, expect } from 'vitest';

import {
  ONBOARDING_TOTAL_STEPS,
  buildOnboardingPlan,
  reconcileProgress,
} from '../../../src/features/onboarding/domain/services/onboarding-plan';
import { OnboardingStatus } from '../../../src/shared/types';

/**
 * Le parcours d'accueil vivait à l'intérieur de `employeeOnboardingWorkflow`,
 * donc atteignable par UN SEUL chemin. Il est extrait ici, en domaine pur.
 *
 * ⚠️ Le catalogue de cinq tâches qu'il portait a été RETIRÉ le 2026-08-14 : aucun
 * mécanisme du système ne pouvait faire avancer ces tâches, donc le suivi qu'elles
 * dessinaient ne bougeait jamais. Le seul suivi du produit est la complétion du
 * profil. Ces tests verrouillent ce que le plan construit ENCORE — un suivi, et
 * rien d'autre.
 */

const EMPLOYEE_ID = '11111111-1111-4111-8111-111111111111';

/** Générateur d'identifiants déterministe : le plan doit être testable. */
function counterIds() {
  let n = 0;
  return () => `id-${++n}`;
}

describe('buildOnboardingPlan', () => {
  it('crée un suivi dimensionné sur la constante du domaine', () => {
    const plan = buildOnboardingPlan({ employeeId: EMPLOYEE_ID, newId: counterIds() });

    expect(plan.progress.employeeId).toBe(EMPLOYEE_ID);
    expect(plan.progress.startedAt).not.toBeNull();
    // Dérivé de la constante, jamais d'un littéral : le jour où une seconde étape
    // apparaît, un `1` en dur ici mentirait sans faire rougir personne.
    expect(plan.progress.totalSteps).toBe(ONBOARDING_TOTAL_STEPS);
    // ⚠️ `InProgress` / `currentStep: 0` ont été corrigés le 2026-08-19. Ce test verrouillait
    // le défaut : le plan n'est construit qu'APRÈS la persistance d'un profil complet, et
    // l'unique étape du parcours EST cette complétion. Le détail est vérifié dans le bloc
    // « le suivi reflète ce qui a été CONSTATÉ » plus bas.
    expect(plan.progress.currentStep).toBe(ONBOARDING_TOTAL_STEPS);
  });

  it('ne construit RIEN d autre que le suivi', () => {
    // Garde-fou de non-régression : la réintroduction silencieuse d'un catalogue de
    // tâches sans mécanisme pour les faire avancer est précisément ce qui a été retiré.
    const plan = buildOnboardingPlan({ employeeId: EMPLOYEE_ID, newId: counterIds() });

    expect(Object.keys(plan)).toEqual(['progress']);
  });

  it('rattache le plan à un suivi existant quand on lui en donne un', () => {
    // Cas du rattrapage : un `onboarding_progress` déjà présent ne doit pas être
    // recréé, sinon un script de rattrapage ne serait pas idempotent.
    const plan = buildOnboardingPlan({
      employeeId: EMPLOYEE_ID,
      newId: counterIds(),
      progressId: 'progress-existant',
    });

    expect(plan.progress.id).toBe('progress-existant');
  });

  it('tire un identifiant neuf quand aucun suivi n est fourni', () => {
    const premier = buildOnboardingPlan({ employeeId: EMPLOYEE_ID });
    const second = buildOnboardingPlan({ employeeId: EMPLOYEE_ID });

    expect(premier.progress.id).not.toBe(second.progress.id);
  });
});

/**
 * ════════════════════════════════════════════════════════════════════════════
 * « 0 sur 1 » enregistré à l'instant où l'unique étape est faite — 2026-08-19
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `buildOnboardingPlan` n'est appelé que par `initOnboardingStep`, c'est-à-dire APRÈS que
 * `createEmployeeStep` a persisté un profil COMPLET. Or l'en-tête de ce module le dit
 * lui-même : « le parcours ne compte qu'une étape : la complétion du profil ». Le système
 * enregistrait donc « 0 sur 1 fait » une étape après avoir observé que la seule étape était
 * faite — et rien ne l'avançait jamais : les seuls écrivains de `currentStep` sont ce chemin
 * et `updateOnboardingStatus`, l'outil que le MODÈLE appelle sur demande d'un humain.
 *
 * C'est le défaut `ONBOARDING_TASKS` recréé sous forme réduite — « un suivi qui ne bouge
 * jamais est un suivi qui ment » — dans le fichier dont l'en-tête affirme l'avoir supprimé.
 * `getEmployeeProfile` remontait fidèlement `in_progress, 0/1` au modèle, qui le remontait à
 * la personne.
 */
describe('le suivi reflète ce qui a été CONSTATÉ, pas un plan', () => {
  it('naît COMPLÉTÉ — il n’est construit qu’après un profil complet', () => {
    const plan = buildOnboardingPlan({ employeeId: 'emp-1', newId: () => 'p-1' });

    expect(plan.progress.currentStep).toBe(ONBOARDING_TOTAL_STEPS);
    expect(plan.progress.status).toBe(OnboardingStatus.Completed);
    expect(plan.progress.completedAt).toBeTruthy();
  });

  it('reste cohérent : jamais plus d’étapes faites que d’étapes au total', () => {
    const plan = buildOnboardingPlan({ employeeId: 'emp-1', newId: () => 'p-1' });
    expect(plan.progress.currentStep).toBeLessThanOrEqual(plan.progress.totalSteps);
  });
});

describe('un suivi ANCIEN est réconcilié, jamais recopié tel quel', () => {
  it('ramène un « 1 sur 5 » hérité au barème courant', () => {
    // Constaté en production le 2026-08-18 : « Statut d'onboarding : en cours (étape 1 sur 5) »
    // alors que `ONBOARDING_TOTAL_STEPS` vaut 1 depuis le retrait du suivi de tâches. La ligne
    // datait d'avant, et le workflow — rendu idempotent — la réutilisait SANS la corriger. Le
    // bot annonçait donc un parcours en cinq étapes dont quatre n'existent plus.
    const reconciled = reconcileProgress({
      id: 'p-1',
      employeeId: 'emp-1',
      currentStep: 1,
      totalSteps: 5,
      status: OnboardingStatus.InProgress,
      startedAt: '2026-08-01T00:00:00.000Z',
      completedAt: null,
      updatedAt: '2026-08-01T00:00:00.000Z',
    });

    expect(reconciled.totalSteps).toBe(ONBOARDING_TOTAL_STEPS);
    expect(reconciled.currentStep).toBe(ONBOARDING_TOTAL_STEPS);
    expect(reconciled.status).toBe(OnboardingStatus.Completed);
  });

  it('ne touche PAS un suivi déjà au barème courant', () => {
    // On ne réécrit que ce qui est incohérent : une écriture inutile est une écriture qui peut
    // se tromper, et `updatedAt` bougerait sans raison.
    const already = {
      id: 'p-1',
      employeeId: 'emp-1',
      currentStep: 1,
      totalSteps: 1,
      status: OnboardingStatus.Completed,
      startedAt: '2026-08-01T00:00:00.000Z',
      completedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };

    expect(reconcileProgress(already)).toBe(already);
  });
});

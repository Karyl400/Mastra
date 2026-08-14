import { describe, it, expect } from 'vitest';

import {
  ONBOARDING_TOTAL_STEPS,
  buildOnboardingPlan,
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
  it('crée un suivi démarré, dimensionné sur la constante du domaine', () => {
    const plan = buildOnboardingPlan({ employeeId: EMPLOYEE_ID, newId: counterIds() });

    expect(plan.progress.employeeId).toBe(EMPLOYEE_ID);
    expect(plan.progress.status).toBe(OnboardingStatus.InProgress);
    expect(plan.progress.startedAt).not.toBeNull();
    // Dérivé de la constante, jamais d'un littéral : le jour où une seconde étape
    // apparaît, un `1` en dur ici mentirait sans faire rougir personne.
    expect(plan.progress.totalSteps).toBe(ONBOARDING_TOTAL_STEPS);
    expect(plan.progress.currentStep).toBe(0);
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

import { describe, it, expect } from 'vitest';

import {
  ONBOARDING_TASKS,
  buildOnboardingPlan,
  dueDateFrom,
} from '../../../src/features/onboarding/domain/services/onboarding-plan';
import { OnboardingStatus, TaskStatus } from '../../../src/shared/types';

/**
 * Le parcours d'accueil vivait à l'intérieur de `employeeOnboardingWorkflow`,
 * donc atteignable par UN SEUL chemin. Résultat mesuré en production le
 * 2026-08-11 : les deux employés en base, créés par le tool `createEmployee`
 * (un simple `repo.save`), n'avaient ni `onboarding_progress` ni tâche — d'où
 * `updateOnboardingStatus` en échec systématique et `getTaskList` vide.
 *
 * Le catalogue et sa mise en plan sont donc extraits ici, en domaine pur, pour
 * que le workflow ET le script de rattrapage partagent la MÊME logique. Toute
 * duplication réintroduirait la divergence qu'on corrige.
 */

const EMPLOYEE_ID = '11111111-1111-4111-8111-111111111111';
const START_DATE = '2026-09-01T00:00:00.000Z';

/** Générateur d'identifiants déterministe : le plan doit être testable. */
function counterIds() {
  let n = 0;
  return () => `id-${++n}`;
}

describe('dueDateFrom', () => {
  it('compte l échéance à partir de la date de début, pas de la date du jour', () => {
    expect(dueDateFrom(START_DATE, 3)).toBe('2026-09-04T00:00:00.000Z');
  });
});

describe('buildOnboardingPlan', () => {
  it('crée un suivi démarré, dimensionné sur le catalogue', () => {
    const plan = buildOnboardingPlan({
      employeeId: EMPLOYEE_ID,
      startDate: START_DATE,
      newId: counterIds(),
    });

    expect(plan.progress.employeeId).toBe(EMPLOYEE_ID);
    expect(plan.progress.status).toBe(OnboardingStatus.InProgress);
    expect(plan.progress.startedAt).not.toBeNull();
    // Dérivé du catalogue, jamais d'un littéral : un `5` en dur mentirait dès
    // la première tâche ajoutée ou retirée.
    expect(plan.progress.totalSteps).toBe(ONBOARDING_TASKS.length);
    expect(plan.progress.currentStep).toBe(0);
  });

  it('crée une tâche par entrée du catalogue, échéancée sur la date de début', () => {
    const plan = buildOnboardingPlan({
      employeeId: EMPLOYEE_ID,
      startDate: START_DATE,
      newId: counterIds(),
    });

    expect(plan.tasks).toHaveLength(ONBOARDING_TASKS.length);
    expect(plan.tasks.map((t) => t.title)).toEqual(ONBOARDING_TASKS.map((t) => t.title));

    for (const [index, task] of plan.tasks.entries()) {
      expect(task.employeeId).toBe(EMPLOYEE_ID);
      expect(task.assigneeId).toBe(EMPLOYEE_ID);
      expect(task.status).toBe(TaskStatus.Pending);
      expect(task.tags).toContain('onboarding');
      expect(task.dueDate).toBe(dueDateFrom(START_DATE, ONBOARDING_TASKS[index]!.dueInDays));
    }
  });

  it('relie chaque tâche à une étape ordonnée du suivi', () => {
    const plan = buildOnboardingPlan({
      employeeId: EMPLOYEE_ID,
      startDate: START_DATE,
      newId: counterIds(),
    });

    expect(plan.steps).toHaveLength(ONBOARDING_TASKS.length);
    expect(plan.steps.map((s) => s.stepOrder)).toEqual(
      ONBOARDING_TASKS.map((_, index) => index + 1),
    );
    expect(plan.steps.map((s) => s.taskId)).toEqual(plan.tasks.map((t) => t.id));
    for (const step of plan.steps) expect(step.progressId).toBe(plan.progress.id);
  });

  it('rattache le plan à un suivi existant quand on lui en donne un', () => {
    // Cas du rattrapage : un `onboarding_progress` déjà présent ne doit pas être
    // recréé, sinon le script de backfill ne serait pas idempotent.
    const plan = buildOnboardingPlan({
      employeeId: EMPLOYEE_ID,
      startDate: START_DATE,
      newId: counterIds(),
      progressId: 'progress-existant',
    });

    expect(plan.progress.id).toBe('progress-existant');
    for (const step of plan.steps) expect(step.progressId).toBe('progress-existant');
  });

  it('n émet que des identifiants distincts', () => {
    const plan = buildOnboardingPlan({ employeeId: EMPLOYEE_ID, startDate: START_DATE });
    const ids = [plan.progress.id, ...plan.tasks.map((t) => t.id), ...plan.steps.map((s) => s.id)];

    expect(new Set(ids).size).toBe(ids.length);
  });
});

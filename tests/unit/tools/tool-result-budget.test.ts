/**
 * Garde-fou de BUDGET sur les tool-results.
 *
 * Contexte — plafond Groq 12 000 tokens/minute. Le préfixe (instructions +
 * schémas des tools) est déjà repayé à chaque aller-retour ; un tool-result
 * volumineux s'y ajoute et reste dans l'historique pour TOUS les tours suivants.
 *
 * Mesuré avant ce lot : `getEmployeeProfile` rendait `tasks` NON BORNÉ, avec les
 * 19 champs de l'entité `Task` — 3 428 caractères ≈ 979 tokens pour UN seul
 * résultat. Deux appels et le budget d'une minute entière est brûlé.
 *
 * Ces tests verrouillent trois propriétés :
 *   1. la BORNE (5 tâches maximum) ;
 *   2. la PROJECTION (seuls les champs utiles sortent — c'est aussi une
 *      protection de confidentialité : `metadata` ne fuite pas) ;
 *   3. la SIGNALISATION de troncature (`totalTasks` / `shown`), sans laquelle le
 *      modèle conclurait à tort qu'il a vu toutes les tâches.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { makeGetEmployeeProfile } from '../../../src/features/employee/application/tools/get-employee-profile';
import { makeGetTaskList } from '../../../src/features/employee/application/tools/get-task-list';
import { MAX_TASKS_IN_RESULT } from '../../../src/features/employee/application/mappers/task-summary.mapper';
import { InMemoryEmployeeRepository } from '../../../src/features/employee/infrastructure/repositories/in-memory-employee.repository';
import { InMemoryTaskRepository } from '../../../src/features/employee/infrastructure/repositories/in-memory-task.repository';
import { InMemoryOnboardingRepository } from '../../../src/features/onboarding/infrastructure/repositories/in-memory-onboarding.repository';
import type { Task } from '../../../src/features/employee/domain/entities/task';
import type { Employee } from '../../../src/features/employee/domain/entities/employee';
import type { OnboardingProgress } from '../../../src/features/onboarding/domain/entities/onboarding-progress';
import {
  EmployeeStatus,
  OnboardingStatus,
  TaskPriority,
  TaskStatus,
  TaskType,
} from '../../../src/shared/types';

const EMPLOYEE_ID = '11111111-1111-4111-8111-111111111111';

const employee: Employee = {
  id: EMPLOYEE_ID,
  firstName: 'Karyl',
  lastName: 'SOUMAILA',
  email: 'karylsoumaila1@gmail.com',
  department: 'Engineering',
  position: 'Software Engineer',
  startDate: '2026-09-01T00:00:00.000Z',
  status: EmployeeStatus.Pending,
  managerId: null,
  createdAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
};

const progress: OnboardingProgress = {
  id: '22222222-2222-4222-8222-222222222222',
  employeeId: EMPLOYEE_ID,
  status: OnboardingStatus.InProgress,
  currentStep: 3,
  totalSteps: 8,
  startedAt: '2026-08-10T00:00:00.000Z',
  completedAt: null,
  createdAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
};

/** Une tâche COMPLÈTE, telle que le repository la rend réellement (19 champs). */
function makeTask(index: number, status: TaskStatus = TaskStatus.Pending): Task {
  return {
    id: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`,
    employeeId: EMPLOYEE_ID,
    assigneeId: null,
    reviewerId: null,
    title: `Tâche d'intégration n°${index}`,
    description:
      'Description longue et verbeuse de la tâche, rédigée pour le tableau de bord RH et sans aucune utilité pour le modèle.',
    type: TaskType.Onboarding,
    status,
    priority: TaskPriority.Medium,
    dueDate: '2026-09-15T00:00:00.000Z',
    startedAt: null,
    completedAt: null,
    deletedAt: null,
    tags: ['onboarding', 'rh', 'j1'],
    metadata: { note: 'confidentiel', internalTicket: 'OPS-4821' },
    version: 1,
    estimatedHours: 2.5,
    actualHours: null,
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
  };
}

/** Champs autorisés dans le résumé d'une tâche exposé au LLM. */
const CHAMPS_TACHE_AUTORISES = ['id', 'title', 'status', 'priority', 'dueDate'] as const;

let employeeRepo: InMemoryEmployeeRepository;
let onboardingRepo: InMemoryOnboardingRepository;
let taskRepo: InMemoryTaskRepository;

beforeEach(async () => {
  employeeRepo = new InMemoryEmployeeRepository();
  onboardingRepo = new InMemoryOnboardingRepository();
  taskRepo = new InMemoryTaskRepository();
  await employeeRepo.save(employee);
  await onboardingRepo.save(progress);
});

async function seedTasks(count: number, status?: TaskStatus) {
  for (let i = 1; i <= count; i++) await taskRepo.save(makeTask(i, status));
}

function profileTool() {
  return makeGetEmployeeProfile(employeeRepo, onboardingRepo, taskRepo);
}

type ProfileResult = {
  employee: Record<string, unknown>;
  progress: Record<string, unknown> | null;
  tasks: Array<Record<string, unknown>>;
  totalTasks: number;
  shown: number;
};

type TaskListResult = {
  tasks: Array<Record<string, unknown>>;
  totalTasks: number;
  shown: number;
};

describe('getEmployeeProfile — budget du tool-result', () => {
  it('borne les tâches à MAX_TASKS_IN_RESULT et annonce la troncature', async () => {
    await seedTasks(12);

    const result = (await profileTool().execute!(
      { employeeId: EMPLOYEE_ID } as never,
      {} as never,
    )) as ProfileResult;

    expect(MAX_TASKS_IN_RESULT).toBe(5);
    expect(result.tasks).toHaveLength(MAX_TASKS_IN_RESULT);
    // Sans ces deux compteurs, le modèle conclut qu'il a vu les 12 tâches.
    expect(result.totalTasks).toBe(12);
    expect(result.shown).toBe(5);
  });

  it('ne tronque pas quand il y a moins de tâches que la borne', async () => {
    await seedTasks(3);

    const result = (await profileTool().execute!(
      { employeeId: EMPLOYEE_ID } as never,
      {} as never,
    )) as ProfileResult;

    expect(result.tasks).toHaveLength(3);
    expect(result.totalTasks).toBe(3);
    expect(result.shown).toBe(3);
  });

  it('ne projette que les champs utiles de chaque tâche', async () => {
    await seedTasks(2);

    const result = (await profileTool().execute!(
      { employeeId: EMPLOYEE_ID } as never,
      {} as never,
    )) as ProfileResult;

    for (const task of result.tasks) {
      expect(Object.keys(task).sort()).toEqual([...CHAMPS_TACHE_AUTORISES].sort());
    }
  });

  it('ne laisse fuiter ni metadata ni description dans la sérialisation', async () => {
    await seedTasks(2);

    const serialise = JSON.stringify(
      await profileTool().execute!({ employeeId: EMPLOYEE_ID } as never, {} as never),
    );

    expect(serialise).not.toContain('confidentiel');
    expect(serialise).not.toContain('OPS-4821');
    expect(serialise).not.toContain('rédigée pour le tableau de bord RH');
  });

  it('projette la progression sans ses champs techniques', async () => {
    await seedTasks(1);

    const result = (await profileTool().execute!(
      { employeeId: EMPLOYEE_ID } as never,
      {} as never,
    )) as ProfileResult;

    expect(result.progress).toEqual({
      status: OnboardingStatus.InProgress,
      currentStep: 3,
      totalSteps: 8,
    });
  });

  it('rend progress à null quand aucune progression n existe', async () => {
    const vide = new InMemoryOnboardingRepository();
    const result = (await makeGetEmployeeProfile(employeeRepo, vide, taskRepo).execute!(
      { employeeId: EMPLOYEE_ID } as never,
      {} as never,
    )) as ProfileResult;

    expect(result.progress).toBeNull();
  });

  it('tient dans un budget de 350 tokens même avec 12 tâches en base', async () => {
    await seedTasks(12);

    const serialise = JSON.stringify(
      await profileTool().execute!({ employeeId: EMPLOYEE_ID } as never, {} as never),
    );
    // Ratio 3,5 caractères/token, calibré sur les mesures réelles du projet.
    const tokens = Math.round(serialise.length / 3.5);

    // Mesure avant ce lot sur le même jeu d'essai : 979 tokens.
    // Le seuil est un garde-fou de NON-RÉGRESSION, pas une cible : le jeu
    // d'essai est volontairement pessimiste (titres longs, UUID complets,
    // dates ISO). Il échoue dès que la borne ou la projection est retirée.
    expect(tokens, `tool-result de ${tokens} tokens (${serialise.length} caractères)`).toBeLessThan(
      350,
    );
  });

  it('rend une taille INDÉPENDANTE du nombre de tâches en base', async () => {
    // C'est la propriété qui compte vraiment : 12 tâches ou 200, le tool-result
    // ne grandit plus. C'est elle qui borne le coût par aller-retour.
    await seedTasks(12);
    const petit = JSON.stringify(
      await profileTool().execute!({ employeeId: EMPLOYEE_ID } as never, {} as never),
    );

    for (let i = 13; i <= 200; i++) await taskRepo.save(makeTask(i));
    const grand = JSON.stringify(
      await profileTool().execute!({ employeeId: EMPLOYEE_ID } as never, {} as never),
    );

    // Seul `totalTasks` change (12 → 200), soit un caractère de plus.
    expect(Math.abs(grand.length - petit.length)).toBeLessThanOrEqual(2);
  });
});

describe('getTaskList — budget du tool-result', () => {
  it('borne les tâches et annonce le total réel', async () => {
    await seedTasks(9);

    const result = (await makeGetTaskList(taskRepo).execute!(
      { employeeId: EMPLOYEE_ID } as never,
      {} as never,
    )) as TaskListResult;

    expect(result.tasks).toHaveLength(MAX_TASKS_IN_RESULT);
    expect(result.totalTasks).toBe(9);
    expect(result.shown).toBe(5);
  });

  it('applique le filtre de statut AVANT la troncature', async () => {
    await seedTasks(4, TaskStatus.Completed);
    await taskRepo.save({ ...makeTask(99), status: TaskStatus.Blocked });

    const result = (await makeGetTaskList(taskRepo).execute!(
      { employeeId: EMPLOYEE_ID, status: TaskStatus.Blocked } as never,
      {} as never,
    )) as TaskListResult;

    expect(result.totalTasks).toBe(1);
    expect(result.shown).toBe(1);
    expect(result.tasks[0]!.status).toBe(TaskStatus.Blocked);
  });

  it('ne projette que les champs utiles de chaque tâche', async () => {
    await seedTasks(2);

    const result = (await makeGetTaskList(taskRepo).execute!(
      { employeeId: EMPLOYEE_ID } as never,
      {} as never,
    )) as TaskListResult;

    for (const task of result.tasks) {
      expect(Object.keys(task).sort()).toEqual([...CHAMPS_TACHE_AUTORISES].sort());
    }
  });

  it('ne laisse fuiter ni metadata ni description dans la sérialisation', async () => {
    await seedTasks(6);

    const serialise = JSON.stringify(
      await makeGetTaskList(taskRepo).execute!({ employeeId: EMPLOYEE_ID } as never, {} as never),
    );

    expect(serialise).not.toContain('confidentiel');
    expect(serialise).not.toContain('OPS-4821');
    expect(serialise).not.toContain('rédigée pour le tableau de bord RH');
  });
});

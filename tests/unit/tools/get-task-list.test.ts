/**
 * `getTaskList` — un UUID inconnu ne doit plus être indiscernable d'un employé
 * sans tâche.
 *
 * Constat (campagne du 2026-08-11) : les deux cas rendaient `{tasks: [], totalTasks: 0}`.
 * Le bot affirmait donc « aucune tâche en cours » pour un identifiant qui ne désigne
 * personne — la même classe de mensonge silencieux que `emailSent: false` avec
 * `status: 'success'`.
 *
 * Modèle suivi : `findEmployeeByEmail`, qui rend `{found: false}`.
 *
 * Le bornage et la projection sont, eux, verrouillés par `tool-result-budget.test.ts`.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { makeGetTaskList } from '../../../src/features/employee/application/tools/get-task-list';
import { InMemoryTaskRepository } from '../../../src/features/employee/infrastructure/repositories/in-memory-task.repository';
import { InMemoryEmployeeRepository } from '../../../src/features/employee/infrastructure/repositories/in-memory-employee.repository';
import { createEmployee } from '../../../src/features/employee/domain/entities/employee';
import type { Task } from '../../../src/features/employee/domain/entities/task';
import { TaskPriority, TaskStatus, TaskType } from '../../../src/shared/types';

const EMPLOYEE_ID = '11111111-1111-4111-8111-111111111111';
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';

function makeTask(i: number): Task {
  return {
    id: `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`,
    employeeId: EMPLOYEE_ID,
    title: `Tâche ${i}`,
    description: 'Description',
    type: TaskType.Onboarding,
    status: TaskStatus.Pending,
    priority: TaskPriority.Medium,
    dueDate: '2026-09-15T00:00:00.000Z',
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
  } as Task;
}

describe('getTaskList — employé inconnu vs employé sans tâche', () => {
  let taskRepo: InMemoryTaskRepository;
  let employeeRepo: InMemoryEmployeeRepository;

  beforeEach(async () => {
    taskRepo = new InMemoryTaskRepository();
    employeeRepo = new InMemoryEmployeeRepository();
    await employeeRepo.save(
      createEmployee({
        id: EMPLOYEE_ID,
        firstName: 'Karyl',
        lastName: 'Soumaila',
        email: 'karyl@kisso.com',
        department: 'Engineering',
        position: 'Software Engineer',
        startDate: '2026-09-01',
        managerId: null,
      }),
    );
  });

  function tool() {
    return makeGetTaskList(taskRepo, employeeRepo);
  }

  it('rend found: false pour un identifiant qui ne désigne personne', async () => {
    const result = (await tool().execute!(
      { employeeId: UNKNOWN_ID } as never,
      {} as never,
    )) as Record<string, unknown>;

    expect(result.found).toBe(false);
    expect(result.tasks).toEqual([]);
    expect(result.totalTasks).toBe(0);
  });

  it('rend found: true pour un employé connu SANS tâche', async () => {
    const result = (await tool().execute!(
      { employeeId: EMPLOYEE_ID } as never,
      {} as never,
    )) as Record<string, unknown>;

    expect(result.found).toBe(true);
    expect(result.tasks).toEqual([]);
    expect(result.totalTasks).toBe(0);
  });

  it('rend found: true et les tâches pour un employé connu qui en a', async () => {
    await taskRepo.save(makeTask(1));
    await taskRepo.save(makeTask(2));

    const result = (await tool().execute!(
      { employeeId: EMPLOYEE_ID } as never,
      {} as never,
    )) as Record<string, unknown>;

    expect(result.found).toBe(true);
    expect(result.totalTasks).toBe(2);
  });

  it("n'interroge même pas les tâches d'un employé inconnu", async () => {
    let calls = 0;
    const spy = {
      ...taskRepo,
      findByEmployee: async (id: string) => {
        calls += 1;
        return taskRepo.findByEmployee(id);
      },
    };

    await makeGetTaskList(spy as never, employeeRepo).execute!(
      { employeeId: UNKNOWN_ID } as never,
      {} as never,
    );

    expect(calls).toBe(0);
  });

  /**
   * `src/mastra/index.ts` (possédé par un autre lot) câble encore
   * `makeGetTaskList(taskRepo)` sans annuaire. Dans ce mode dégradé, le tool ne
   * doit surtout pas AFFIRMER `found: true` — il ne peut pas le savoir. Il omet
   * alors le champ plutôt que d'inventer une réponse.
   */
  it('omet `found` quand aucun annuaire ne lui est câblé, au lieu de deviner', async () => {
    const result = (await makeGetTaskList(taskRepo).execute!(
      { employeeId: UNKNOWN_ID } as never,
      {} as never,
    )) as Record<string, unknown>;

    expect('found' in result).toBe(false);
  });
});

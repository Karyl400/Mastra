import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { EmployeeRepository } from '../../domain/ports/employee.repository';
import type { OnboardingRepository } from '../../../onboarding/domain/ports/onboarding.repository';
import type { TaskRepository } from '../../domain/ports/task.repository';
import { uuidSchema } from '../../../../shared/validation';
import { logger } from '../../../../shared/logger';
import { NotFoundError } from '../../../../shared/errors';
import { summarizeTasks } from '../mappers/task-summary.mapper';

export function makeGetEmployeeProfile(
  empRepo: EmployeeRepository,
  onboardingRepo: OnboardingRepository,
  taskRepo: TaskRepository,
) {
  return createTool({
    id: 'getEmployeeProfile',
    description: 'Récupère le profil complet d un employé avec son onboarding et ses tâches',
    inputSchema: z.object({
      employeeId: uuidSchema.describe('ID de l employé'),
    }),
    execute: async (data, _ctx) => {
      logger.info('Récupération profil employé', { employeeId: data.employeeId });
      const employee = await empRepo.findById(data.employeeId);
      if (!employee) throw new NotFoundError('Employé', data.employeeId);

      const progress = await onboardingRepo.findByEmployee(data.employeeId);
      const tasks = await taskRepo.findByEmployee(data.employeeId);

      // PROJECTION EXPLICITE, et non `return { employee }`.
      //
      // `DrizzleEmployeeRepository.findById` fait un `db.select()` sans argument
      // — donc un `SELECT *` sur 20 colonnes — puis un `as Employee`. Cette
      // assertion est effacée à la compilation : elle ne retire AUCUNE propriété
      // à l'exécution, et `JSON.stringify` sérialise l'objet réel. Les colonnes
      // `salary_amount`, `phone`, `emergency_contact_*` et `metadata` existent en
      // base et partiraient telles quelles dans le contexte du LLM, donc
      // potentiellement dans une réponse Slack visible par n'importe quel membre
      // du workspace.
      //
      // Le profil ne fuite rien AUJOURD'HUI seulement parce que l'entité
      // `Employee` ne déclare pas ces champs — une protection par coïncidence,
      // pas par conception. On énumère donc ce qu'on expose, sur le modèle de
      // `find-employee-by-email.ts`. Verrouillé par un test.
      //
      // La même règle s'applique désormais à `progress` et `tasks`, pour la même
      // raison de fond ET pour le budget de tokens : `tasks` était NON BORNÉ et
      // rendait les 19 champs de l'entité `Task` (3 428 caractères ≈ 979 tokens
      // mesurés pour un seul résultat, réémis à chaque aller-retour). Voir
      // `task-summary.mapper.ts`.
      return {
        employee: {
          id: employee.id,
          firstName: employee.firstName,
          lastName: employee.lastName,
          email: employee.email,
          department: employee.department,
          position: employee.position,
          startDate: employee.startDate,
          status: employee.status,
          managerId: employee.managerId ?? null,
        },
        progress: progress
          ? {
              status: progress.status,
              currentStep: progress.currentStep,
              totalSteps: progress.totalSteps,
            }
          : null,
        ...summarizeTasks(tasks),
      };
    },
  });
}

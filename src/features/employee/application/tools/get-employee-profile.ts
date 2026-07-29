import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { EmployeeRepository } from '../../domain/ports/employee.repository';
import type { OnboardingRepository } from '../../../onboarding/domain/ports/onboarding.repository';
import type { TaskRepository } from '../../domain/ports/task.repository';import { uuidSchema } from '../../../../shared/validation';
import { logger } from '../../../../shared/logger';
import { NotFoundError } from '../../../../shared/errors';

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

      return { employee, progress, tasks };
    },
  });
}

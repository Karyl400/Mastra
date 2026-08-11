import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { TaskRepository } from '../../domain/ports/task.repository';
import { uuidSchema } from '../../../../shared/validation';
import { logger } from '../../../../shared/logger';
import { summarizeTasks } from '../mappers/task-summary.mapper';

export function makeGetTaskList(repo: TaskRepository) {
  return createTool({
    id: 'getTaskList',
    description: 'Récupère la liste des tâches d un employé avec filtres optionnels',
    inputSchema: z.object({
      employeeId: uuidSchema.describe('ID de l employé'),
      status: z
        .string()
        .optional()
        .describe('Filtre par statut (pending, in_progress, completed, blocked)'),
    }),
    execute: async (data, _ctx) => {
      logger.info('Récupération tâches', { employeeId: data.employeeId });
      let tasks = await repo.findByEmployee(data.employeeId);
      if (data.status) {
        tasks = tasks.filter((t) => t.status === data.status);
      }
      // Filtrage D'ABORD, troncature ENSUITE : `totalTasks` doit compter les
      // tâches qui correspondent à la demande, pas celles de l'employé.
      // Projection + borne : voir `task-summary.mapper.ts`.
      return summarizeTasks(tasks);
    },
  });
}

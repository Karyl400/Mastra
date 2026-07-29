import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { TaskRepository } from '../../domain/ports/task.repository';
import { uuidSchema } from '../../../../shared/validation';
import { logger } from '../../../../shared/logger';

export function makeGetTaskList(repo: TaskRepository) {
  return createTool({
    id: 'getTaskList',
    description: 'Récupère la liste des tâches d un employé avec filtres optionnels',
    inputSchema: z.object({
      employeeId: uuidSchema.describe('ID de l employé'),
      status: z.string().optional().describe('Filtre par statut (pending, in_progress, completed, blocked)'),
    }),
    execute: async (data, _ctx) => {
      logger.info('Récupération tâches', { employeeId: data.employeeId });
      let tasks = await repo.findByEmployee(data.employeeId);
      if (data.status) {
        tasks = tasks.filter(t => t.status === data.status);
      }
      return { tasks, total: tasks.length };
    },
  });
}

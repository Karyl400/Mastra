import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { TaskRepository } from '../../domain/ports/task.repository';
import type { EmployeeRepository } from '../../domain/ports/employee.repository';
import { uuidSchema } from '../../../../shared/validation';
import { logger } from '../../../../shared/logger';
import { canReadPersonRecord } from '../../../../shared/slack-request-context';
import { summarizeTasks } from '../mappers/task-summary.mapper';

/**
 * Consigne rendue quand le demandeur n'a pas le droit de lire les tâches de cette personne.
 * Même rédaction que dans `get-employee-profile.ts`, et pour les mêmes raisons : elle nomme
 * la règle sans jamais nommer la donnée, et interdit explicitement de réessayer.
 */
const NOT_AUTHORIZED_HINT =
  "Tu n'as pas accès aux tâches de cette personne. Dis-le simplement, sans détour et sans " +
  'inventer de motif. Ne réessaie pas avec un autre outil et ne reformule pas la demande.';

/**
 * Liste des tâches d'un employé.
 *
 * ## Pourquoi un `found`
 *
 * Un UUID inconnu et un employé sans tâche rendaient exactement le même résultat —
 * `{tasks: [], totalTasks: 0}`. Le modèle n'avait alors aucun moyen de les
 * distinguer et répondait « aucune tâche en cours » pour un identifiant qui ne
 * désigne personne. C'est la même classe de mensonge silencieux que `emailSent: false`
 * avec `status: 'success'` : la réponse est bien formée, elle est simplement fausse.
 * `findEmployeeByEmail` résout déjà ce problème en rendant `{found: false}` ; on suit
 * le même modèle.
 *
 * @param employeeRepo Annuaire. Optionnel UNIQUEMENT parce que `src/mastra/index.ts`
 *   (possédé par un autre lot) câble encore `makeGetTaskList(taskRepo)`. Sans lui, le
 *   tool n'a aucun moyen de savoir si l'employé existe : il OMET alors `found` plutôt
 *   que d'affirmer une valeur qu'il ne peut pas connaître.
 */
export function makeGetTaskList(repo: TaskRepository, employeeRepo?: EmployeeRepository) {
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
      // AVANT toute lecture en base — voir `canReadPersonRecord`. Le refus ne dit PAS si
      // l'identifiant désigne quelqu'un : `found: false` est déjà le résultat d'un UUID
      // inconnu, donc les deux cas sont indiscernables de l'extérieur. C'est voulu — le
      // motif renseigne le modèle, pas le résultat.
      if (!canReadPersonRecord(_ctx?.requestContext, data.employeeId)) {
        logger.warn('Lecture de tâches refusée — demandeur non autorisé', {
          employeeId: data.employeeId,
        });
        return {
          found: false,
          tasks: [],
          totalTasks: 0,
          shown: 0,
          reason: 'not_authorized' as const,
          hint: NOT_AUTHORIZED_HINT,
        };
      }

      logger.info('Récupération tâches', { employeeId: data.employeeId });

      if (employeeRepo) {
        const employee = await employeeRepo.findById(data.employeeId);
        if (!employee) {
          // On n'interroge même pas les tâches : il n'y a personne à qui elles
          // pourraient appartenir, et une liste vide serait lue comme « rien à faire ».
          logger.warn('Tâches demandées pour un employé inconnu', {
            employeeId: data.employeeId,
          });
          return { found: false, tasks: [], totalTasks: 0, shown: 0 };
        }
      }

      let tasks = await repo.findByEmployee(data.employeeId);
      if (data.status) {
        tasks = tasks.filter((t) => t.status === data.status);
      }
      // Filtrage D'ABORD, troncature ENSUITE : `totalTasks` doit compter les
      // tâches qui correspondent à la demande, pas celles de l'employé.
      // Projection + borne : voir `task-summary.mapper.ts`.
      const page = summarizeTasks(tasks);
      return employeeRepo ? { found: true, ...page } : page;
    },
  });
}

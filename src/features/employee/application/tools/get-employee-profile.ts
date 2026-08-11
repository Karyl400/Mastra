import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { EmployeeRepository } from '../../domain/ports/employee.repository';
import type { OnboardingRepository } from '../../../onboarding/domain/ports/onboarding.repository';
import type { TaskRepository } from '../../domain/ports/task.repository';
import { uuidSchema } from '../../../../shared/validation';
import { logger } from '../../../../shared/logger';
import { summarizeTasks } from '../mappers/task-summary.mapper';

/**
 * Consigne rendue au modèle quand l'identifiant ne désigne personne.
 *
 * Le tool levait `NotFoundError` ici. Or l'AI SDK v7 convertit ce que lève un
 * tool en part `tool-error` RÉINJECTÉE au modèle — le catch générique du
 * handler Slack n'est jamais atteint. Face à un vide, le modèle comble : c'est
 * ainsi qu'est né l'over-promise « as-tu besoin que je crée un profil ? », pour
 * une capacité qu'aucun agent ne possède. Un résultat qui INSTRUIT vaut mieux
 * qu'une exception ; même motif que `find-employee-by-email.ts`.
 */
const NOT_FOUND_HINT =
  "Aucun employé ne porte cet identifiant. Ne l'invente pas et n'en déduis rien : demande " +
  "l'email professionnel et passe par findEmployeeByEmail.";

/**
 * Consigne rendue quand l'employé existe mais n'a pas de suivi d'intégration.
 *
 * État réel des deux employés de production au 2026-08-11 : créés par le tool
 * `createEmployee` (un simple `repo.save`), ils n'ont ni `onboarding_progress`
 * ni tâche. Un `progress: null` nu se lisait comme « il n'y a plus qu'à le
 * créer » — d'où la proposition de création. Le rattrapage a un propriétaire :
 * `scripts/backfill-onboarding.mts`, pas le modèle.
 */
const NO_PROGRESS_HINT =
  "Suivi d'intégration non initialisé pour cet employé. Tu n'as aucun outil pour le créer : " +
  'signale-le, ne propose pas de le créer.';

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

      if (!employee) {
        // `warn` volontaire : un identifiant qui ne désigne personne signale
        // presque toujours une valeur fabriquée par le modèle.
        logger.warn('Aucun employé pour cet identifiant', { employeeId: data.employeeId });
        return {
          found: false as const,
          reason: 'employee_not_found' as const,
          hint: NOT_FOUND_HINT,
        };
      }

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
        // Symétrique de `findEmployeeByEmail` : le modèle distingue le succès de
        // l'échec sur le MÊME champ, quel que soit le tool.
        found: true as const,
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
        // Le `hint` n'est payé que dans le cas dégradé : quand le suivi existe,
        // pas un caractère de plus dans le contexte du modèle.
        ...(progress ? {} : { onboardingHint: NO_PROGRESS_HINT }),
        ...summarizeTasks(tasks),
      };
    },
  });
}

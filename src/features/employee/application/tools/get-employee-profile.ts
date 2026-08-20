import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { EmployeeRepository } from '../../domain/ports/employee.repository';
import type { Employee } from '../../domain/entities/employee';
import type { OnboardingRepository } from '../../../onboarding/domain/ports/onboarding.repository';
import type { OnboardingProgress } from '../../../onboarding/domain/entities/onboarding-progress';
import { uuidSchema, emailSchema } from '../../../../shared/validation';
import { logger } from '../../../../shared/logger';
import { canReadPersonRecord } from '../../../../shared/slack-request-context';
import { reconcileProgress } from '../../../onboarding/domain/services/onboarding-plan';

const NOT_FOUND_HINT =
  "Aucun employé ne porte cet identifiant. Ne l'invente pas et n'en déduis rien : demande " +
  "l'email de la personne et passe par findEmployeeByEmail.";

const NO_PROGRESS_HINT =
  "Suivi d'intégration non initialisé pour cet employé. Tu n'as aucun outil pour le créer : " +
  'signale-le, ne propose pas de le créer.';

const NOT_AUTHORIZED_HINT =
  "Tu n'as pas accès au dossier de cette personne. Dis-le simplement, sans détour et sans " +
  'inventer de motif. Ne réessaie pas avec un autre outil et ne reformule pas la demande.';

const MISSING_IDENTIFIER_HINT =
  "Précise QUI : soit l'email, soit l'identifiant de l'employé. N'en invente " +
  'aucun — si tu ne les as pas, demande-les.';

export function makeGetEmployeeProfile(
  empRepo: EmployeeRepository,
  onboardingRepo: OnboardingRepository,
) {
  return createTool({
    id: 'getEmployeeProfile',
    description: "Récupère le profil d un employé et l'avancement de son intégration",
    inputSchema: z.object({
      employeeId: uuidSchema.optional().describe('ID de l employé'),
      email: emailSchema
        .optional()
        .describe("Email pro — alternative à employeeId, évite de résoudre la personne d'abord"),
    }),
    execute: async (data, _ctx) => {
      const email = data.email ? String(data.email).trim().toLowerCase() : undefined;

      if (!data.employeeId && !email) {
        return {
          found: false as const,
          reason: 'missing_identifier' as const,
          hint: MISSING_IDENTIFIER_HINT,
        };
      }

      if (!data.employeeId && email) {
        const resolved = await empRepo.findByEmail(email);

        if (!canReadPersonRecord(_ctx?.requestContext, resolved?.id ?? null)) {
          logger.warn('Lecture de profil refusée — demandeur non autorisé (par email)');
          return {
            found: false as const,
            reason: 'not_authorized' as const,
            hint: NOT_AUTHORIZED_HINT,
          };
        }

        if (!resolved) {
          logger.warn('Aucun employé pour cette adresse');
          return {
            found: false as const,
            reason: 'employee_not_found' as const,
            hint: NOT_FOUND_HINT,
          };
        }

        return project(resolved, await onboardingRepo.findByEmployee(resolved.id));
      }

      const employeeId = data.employeeId as string;

      if (!canReadPersonRecord(_ctx?.requestContext, employeeId)) {
        logger.warn('Lecture de profil refusée — demandeur non autorisé', { employeeId });
        return {
          found: false as const,
          reason: 'not_authorized' as const,
          hint: NOT_AUTHORIZED_HINT,
        };
      }

      logger.info('Récupération profil employé', { employeeId });
      const employee = await empRepo.findById(employeeId);

      if (!employee) {
        logger.warn('Aucun employé pour cet identifiant', { employeeId });
        return {
          found: false as const,
          reason: 'employee_not_found' as const,
          hint: NOT_FOUND_HINT,
        };
      }

      return project(employee, await onboardingRepo.findByEmployee(employeeId));
    },
  });
}

function project(employee: Employee, progress: OnboardingProgress | null) {
  const view = progress ? reconcileProgress(progress) : null;

  return {
    found: true as const,
    employee: {
      firstName: employee.firstName,
      lastName: employee.lastName,
      email: employee.email,
      position: employee.position,
    },
    progress: view
      ? {
          status: view.status,
          currentStep: view.currentStep,
          totalSteps: view.totalSteps,
        }
      : null,
    ...(progress ? {} : { onboardingHint: NO_PROGRESS_HINT }),
  };
}

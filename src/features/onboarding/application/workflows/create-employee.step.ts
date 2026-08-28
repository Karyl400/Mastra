import { createStep } from '@mastra/core/workflows';
import { logger } from '../../../../shared/logger';
import { createEmployee } from '../../../employee/domain/entities/employee';
import { employeeCreatedSchema, onboardingInputSchema } from './employee-onboarding-schemas';
import type { OnboardingWorkflowDeps } from './onboarding-workflow-deps';

export function makeCreateEmployeeStep(deps: OnboardingWorkflowDeps) {
  const createEmployeeStep = createStep({
    id: 'createEmployee',
    description: "Crée le profil de l'employé et vérifie l'unicité de l'email",
    inputSchema: onboardingInputSchema,
    outputSchema: employeeCreatedSchema,
    execute: async ({ inputData }) => {
      logger.info('Onboarding — création employé', { email: inputData.email });

      const existing = await deps.employeeRepo.findByEmail(inputData.email);
      if (existing) {
        logger.info('Onboarding — dossier déjà existant, réutilisé', {
          employeeId: existing.id,
        });
        return {
          employeeId: existing.id,
          alreadyExisted: true,
          email: existing.email,
          firstName: existing.firstName,
          lastName: existing.lastName,
          department: existing.department ?? null,
          position: existing.position,
          startDate: existing.startDate,
          slackChannelId: inputData.slackChannelId ?? null,
        };
      }

      const normalizedInput = {
        ...inputData,
        managerId: inputData.managerId ?? null,
        slackChannelId: inputData.slackChannelId ?? null,
        department: inputData.department ?? null,
      };

      const employee = createEmployee({
        id: crypto.randomUUID(),
        firstName: normalizedInput.firstName,
        lastName: normalizedInput.lastName,
        email: normalizedInput.email,
        department: normalizedInput.department ?? null,
        position: normalizedInput.position,
        startDate: normalizedInput.startDate,
        managerId: normalizedInput.managerId,
      });

      await deps.employeeRepo.save(employee);

      logger.info('Employé créé', { employeeId: employee.id });

      return {
        employeeId: employee.id,
        alreadyExisted: false,
        email: employee.email,
        firstName: employee.firstName,
        lastName: employee.lastName,
        department: employee.department,
        position: employee.position,
        startDate: employee.startDate,
        slackChannelId: normalizedInput.slackChannelId,
      };
    },
  });

  return createEmployeeStep;
}

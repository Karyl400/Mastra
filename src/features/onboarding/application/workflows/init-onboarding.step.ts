import { createStep } from '@mastra/core/workflows';
import { logger } from '../../../../shared/logger';
import { buildOnboardingPlan, reconcileProgress } from '../../domain/services/onboarding-plan';
import type { StepFailure } from '../../domain/value-objects/onboarding-outcome';
import { employeeCreatedSchema, onboardingInitializedSchema } from './employee-onboarding-schemas';
import type { OnboardingWorkflowDeps } from './onboarding-workflow-deps';

export function makeInitOnboardingStep(deps: OnboardingWorkflowDeps) {
  const initOnboardingStep = createStep({
    id: 'initOnboarding',
    description: "Crée le suivi d'onboarding avec les étapes initiales",
    inputSchema: employeeCreatedSchema,
    outputSchema: onboardingInitializedSchema,
    execute: async ({ inputData }) => {
      logger.info('Onboarding — initialisation progress', { employeeId: inputData.employeeId });

      const existingProgress = await deps.onboardingRepo.findByEmployee(inputData.employeeId);
      const reconciled = existingProgress ? reconcileProgress(existingProgress) : null;
      const started =
        reconciled ?? buildOnboardingPlan({ employeeId: inputData.employeeId }).progress;

      if (!existingProgress) {
        await deps.onboardingRepo.save(started);
      } else if (reconciled !== existingProgress) {
        logger.info('Onboarding — suivi hérité ramené au barème courant', {
          progressId: started.id,
          totalSteps: started.totalSteps,
        });
        await deps.onboardingRepo.update(started);
      } else {
        logger.info('Onboarding — suivi déjà existant, réutilisé', { progressId: started.id });
      }

      const degraded: StepFailure[] = [];

      logger.info('Onboarding progress créé', { progressId: started.id });

      return {
        employeeId: inputData.employeeId,
        alreadyExisted: inputData.alreadyExisted,
        progressId: started.id,
        email: inputData.email,
        firstName: inputData.firstName,
        lastName: inputData.lastName,
        position: inputData.position,
        startDate: inputData.startDate,
        slackChannelId: inputData.slackChannelId,
        degraded,
      };
    },
  });

  return initOnboardingStep;
}

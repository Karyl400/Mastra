import { createStep } from '@mastra/core/workflows';
import { logger } from '../../../../shared/logger';
import { errorMessage } from '../../../../shared/errors';
import {
  BestEffortStep,
  OnboardingOutcome,
  describeDegradation,
  outcomeOf,
  toFailureReason,
  type StepFailure,
} from '../../domain/value-objects/onboarding-outcome';
import { onboardingOutputSchema, welcomeSentSchema } from './employee-onboarding-schemas';
import type { OnboardingWorkflowDeps } from './onboarding-workflow-deps';

export function makeInviteToSlackStep(deps: OnboardingWorkflowDeps) {
  const inviteToSlackStep = createStep({
    id: 'inviteToSlack',
    description: "Trouve l'utilisateur Slack par email et l'invite dans le channel département",
    inputSchema: welcomeSentSchema,
    outputSchema: onboardingOutputSchema,
    execute: async ({ inputData }) => {
      const degraded: StepFailure[] = [...inputData.degraded];

      const conclude = (slack: { slackInvited: boolean; slackUserId?: string }) => {
        const outcome = outcomeOf(degraded);

        if (outcome === OnboardingOutcome.Degraded) {
          logger.error('Onboarding terminé en mode DÉGRADÉ', {
            employeeId: inputData.employeeId,
            outcome,
            degradedSteps: describeDegradation(degraded),
          });
        } else {
          logger.info('Onboarding terminé', { employeeId: inputData.employeeId, outcome });
        }

        return {
          employeeId: inputData.employeeId,
          outcome,
          emailSent: inputData.emailSent,
          slackInvited: slack.slackInvited,
          slackUserId: slack.slackUserId,
          degradedSteps: degraded,
        };
      };

      if (!deps.slackProvider || !inputData.slackChannelId) {
        logger.info('Invitation Slack ignorée (provider ou channel absent)', {
          employeeId: inputData.employeeId,
          hasProvider: !!deps.slackProvider,
          hasChannel: !!inputData.slackChannelId,
        });
        return conclude({ slackInvited: false });
      }

      try {
        const member = await deps.slackProvider.findUserByEmail(inputData.email);

        if (!member) {
          logger.warn('Utilisateur Slack non trouvé', { email: inputData.email });
          degraded.push({
            step: BestEffortStep.SlackInvite,
            reason: 'aucun compte Slack ne correspond à cet email',
          });
          return conclude({ slackInvited: false });
        }

        await deps.slackProvider.inviteToChannel(inputData.slackChannelId, member.id);

        logger.info('Employé invité sur Slack', {
          slackUserId: member.id,
          channelId: inputData.slackChannelId,
        });

        return conclude({ slackInvited: true, slackUserId: member.id });
      } catch (err) {
        logger.error('Échec invitation Slack (non bloquant)', {
          error: errorMessage(err),
          employeeId: inputData.employeeId,
        });
        degraded.push({ step: BestEffortStep.SlackInvite, reason: toFailureReason(err) });
        return conclude({ slackInvited: false });
      }
    },
  });

  return inviteToSlackStep;
}

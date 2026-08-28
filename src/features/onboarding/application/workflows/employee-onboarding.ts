import { Workflow } from '@mastra/core/workflows';
import type { EmployeeRepository } from '../../../employee/domain/ports/employee.repository';
import type { OnboardingRepository } from '../../domain/ports/onboarding.repository';
import type { NotificationRepository } from '../../../notification/domain/ports/notification.repository';
import type { EmailProvider } from '../../../notification/domain/ports/providers';
import type { SlackWorkspaceProvider } from '../../../notification/domain/ports/slack-workspace.port';
import { onboardingInputSchema, onboardingOutputSchema } from './employee-onboarding-schemas';
import { makeCreateEmployeeStep } from './create-employee.step';
import { makeInitOnboardingStep } from './init-onboarding.step';
import { makeSendWelcomeEmailStep } from './send-welcome-email.step';
import { makeInviteToSlackStep } from './invite-to-slack.step';

export function createEmployeeOnboardingWorkflow(deps: {
  employeeRepo: EmployeeRepository;
  onboardingRepo: OnboardingRepository;
  notificationRepo: NotificationRepository;
  emailProvider: EmailProvider;
  slackProvider?: SlackWorkspaceProvider;
}) {
  const createEmployeeStep = makeCreateEmployeeStep(deps);
  const initOnboardingStep = makeInitOnboardingStep(deps);
  const sendWelcomeEmailStep = makeSendWelcomeEmailStep(deps);
  const inviteToSlackStep = makeInviteToSlackStep(deps);

  const workflow = new Workflow({
    id: 'employee-onboarding',
    description:
      "Processus complet d'onboarding : création employé → onboarding progress → email de bienvenue → invitation Slack",
    inputSchema: onboardingInputSchema,
    outputSchema: onboardingOutputSchema,
  });

  workflow
    .then(createEmployeeStep)
    .then(initOnboardingStep)
    .then(sendWelcomeEmailStep)
    .then(inviteToSlackStep)
    .commit();

  return workflow;
}

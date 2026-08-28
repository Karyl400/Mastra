import { createStep } from '@mastra/core/workflows';
import { logger } from '../../../../shared/logger';
import { errorMessage } from '../../../../shared/errors';
import { buildWelcomeEmail } from '../../domain/services/welcome-email';
import {
  BestEffortStep,
  toFailureReason,
  type StepFailure,
} from '../../domain/value-objects/onboarding-outcome';
import { htmlEmailBody } from '../../../notification/domain/services/email-body';
import { createNotification } from '../../../notification/domain/entities/notification';
import { NotificationChannel, NotificationStatus, RecipientType } from '../../../../shared/types';
import { onboardingInitializedSchema, welcomeSentSchema } from './employee-onboarding-schemas';
import type { OnboardingWorkflowDeps } from './onboarding-workflow-deps';

export function makeSendWelcomeEmailStep(deps: OnboardingWorkflowDeps) {
  const sendWelcomeEmailStep = createStep({
    id: 'sendWelcomeEmail',
    description: "Envoie l'email de bienvenue et persiste la notification",
    inputSchema: onboardingInitializedSchema,
    outputSchema: welcomeSentSchema,
    execute: async ({ inputData }) => {
      logger.info('Onboarding — envoi email de bienvenue', { email: inputData.email });

      const { subject, body } = buildWelcomeEmail({
        firstName: inputData.firstName,
        lastName: inputData.lastName,
        position: inputData.position,
        startDate: inputData.startDate,
      });

      let emailSent = false;
      const degraded: StepFailure[] = [...inputData.degraded];

      if (inputData.alreadyExisted) {
        logger.info('Email de bienvenue NON envoyé — dossier préexistant', {
          employeeId: inputData.employeeId,
        });
        return { ...inputData, emailSent: false, degraded };
      }

      try {
        await deps.emailProvider.sendEmail(inputData.email, subject, htmlEmailBody(body));
        emailSent = true;
        logger.info('Email de bienvenue envoyé', { email: inputData.email });
      } catch (err) {
        degraded.push({ step: BestEffortStep.WelcomeEmail, reason: toFailureReason(err) });
        logger.error('Échec envoi email de bienvenue', {
          error: errorMessage(err),
          email: inputData.email,
        });
      }

      const notif = createNotification({
        id: crypto.randomUUID(),
        recipientId: inputData.employeeId,
        recipientType: RecipientType.Employee,
        channel: NotificationChannel.Email,
        subject,
        body,
      });

      const persisted = {
        ...notif,
        status: emailSent ? NotificationStatus.Sent : NotificationStatus.Failed,
        sentAt: emailSent ? new Date().toISOString() : null,
        updatedAt: new Date().toISOString(),
      };

      await deps.notificationRepo.save(persisted);

      return {
        employeeId: inputData.employeeId,
        email: inputData.email,
        firstName: inputData.firstName,
        lastName: inputData.lastName,
        emailSent,
        slackChannelId: inputData.slackChannelId,
        degraded,
      };
    },
  });

  return sendWelcomeEmailStep;
}

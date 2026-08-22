import { Workflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { logger } from '../../../../shared/logger';
import { errorMessage } from '../../../../shared/errors';
import { buildWelcomeEmail } from '../../domain/services/welcome-email';
import { createEmployee } from '../../../employee/domain/entities/employee';
import { buildOnboardingPlan, reconcileProgress } from '../../domain/services/onboarding-plan';
import {
  BestEffortStep,
  OnboardingOutcome,
  describeDegradation,
  outcomeOf,
  toFailureReason,
  type StepFailure,
} from '../../domain/value-objects/onboarding-outcome';
import type { EmployeeRepository } from '../../../employee/domain/ports/employee.repository';
import type { OnboardingRepository } from '../../domain/ports/onboarding.repository';
import type { NotificationRepository } from '../../../notification/domain/ports/notification.repository';
import type { EmailProvider } from '../../../notification/domain/ports/providers';
import { htmlEmailBody } from '../../../notification/domain/services/email-body';
import type { SlackWorkspaceProvider } from '../../../notification/domain/ports/slack-workspace.port';
import { createNotification } from '../../../notification/domain/entities/notification';
import {
  NotificationChannel,
  NotificationStatus,
  RecipientType,
  Department,
} from '../../../../shared/types';
import { VALIDATION_CONSTRAINTS } from '../../../../shared/validation';

const onboardingInputSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  department: z.nativeEnum(Department).nullable().optional(),
  position: z
    .string()
    .min(VALIDATION_CONSTRAINTS.POSITION.MIN_LENGTH, 'position is too short')
    .max(VALIDATION_CONSTRAINTS.POSITION.MAX_LENGTH, 'position is too long')
    .regex(VALIDATION_CONSTRAINTS.POSITION.PATTERN, VALIDATION_CONSTRAINTS.POSITION.MESSAGE),
  startDate: z.string().datetime(),
  managerId: z.string().uuid().nullable().optional(),
  slackChannelId: z
    .string()
    .nullable()
    .optional()
    .describe('Channel Slack du département (optionnel)'),
});

const employeeCreatedSchema = z.object({
  employeeId: z.string().uuid(),
  alreadyExisted: z.boolean(),
  email: z.string().email(),
  firstName: z.string(),
  lastName: z.string(),
  department: z.string().nullable(),
  position: z.string(),
  startDate: z.string(),
  slackChannelId: z.string().nullable().optional(),
});

const stepFailureSchema = z.object({
  step: z.nativeEnum(BestEffortStep),
  reason: z.string(),
});

const onboardingInitializedSchema = z.object({
  employeeId: z.string().uuid(),
  alreadyExisted: z.boolean(),
  progressId: z.string().uuid(),
  email: z.string().email(),
  firstName: z.string(),
  lastName: z.string(),
  position: z.string(),
  startDate: z.string(),
  slackChannelId: z.string().nullable().optional(),
  degraded: z.array(stepFailureSchema),
});

const welcomeSentSchema = z.object({
  employeeId: z.string().uuid(),
  email: z.string().email(),
  firstName: z.string(),
  lastName: z.string(),
  emailSent: z.boolean(),
  slackChannelId: z.string().nullable().optional(),
  degraded: z.array(stepFailureSchema),
});

const onboardingOutputSchema = z.object({
  employeeId: z.string().uuid(),
  outcome: z.nativeEnum(OnboardingOutcome),
  emailSent: z.boolean(),
  slackInvited: z.boolean(),
  slackUserId: z.string().optional(),
  degradedSteps: z.array(stepFailureSchema),
});

export function createEmployeeOnboardingWorkflow(deps: {
  employeeRepo: EmployeeRepository;
  onboardingRepo: OnboardingRepository;
  notificationRepo: NotificationRepository;
  emailProvider: EmailProvider;
  slackProvider?: SlackWorkspaceProvider;
}) {
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

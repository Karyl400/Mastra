import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({
  path: path.resolve(process.cwd(), '.env'),
});
import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { VercelDeployer } from '@mastra/deployer-vercel';

import { DrizzleEmployeeRepository } from '../features/employee/infrastructure/repositories/drizzle-employee.repository';
import { DrizzleDocumentRepository } from '../features/document/infrastructure/repositories/drizzle-document.repository';
import { DrizzleNotificationRepository } from '../features/notification/infrastructure/repositories/drizzle-notification.repository';
import { DrizzleOnboardingRepository } from '../features/onboarding/infrastructure/repositories/drizzle-onboarding.repository';
import { DrizzleOnboardingInterviewRepository } from '../features/onboarding/infrastructure/repositories/drizzle-onboarding-interview.repository';
import { DrizzleChannelInventoryRepository } from '../features/directory/infrastructure/repositories/drizzle-channel.repository';

import { healthCheck } from '../infrastructure/database/connection';

import { makeFindEmployeeByEmail } from '../features/employee/application/tools/find-employee-by-email';
import { makeFindPersonByName } from '../features/employee/application/tools/find-person-by-name';
import { makeGetEmployeeProfile } from '../features/employee/application/tools/get-employee-profile';
import { makeUpdateOnboardingStatus } from '../features/onboarding/application/tools/update-onboarding-status';
import { makeGenerateDocument } from '../features/document/application/tools/generate-document';
import { makeSendNotification } from '../features/notification/application/tools/send-notification';
import { makeScheduleReminder } from '../features/notification/application/tools/schedule-reminder';
import { makeGetNotificationHistory } from '../features/notification/application/tools/get-notification-history';

import { makeOnboardingOrchestrator } from '../features/onboarding/application/agents/onboarding-orchestrator';
import { makeNotificationAgent } from '../features/notification/application/agents/notification-agent';
import { makeKnowledgeAgent } from '../features/knowledge/application/agents/knowledge-agent';
import { makeRecruitmentAgent } from '../features/recruitment/application/agents/recruitment-agent';
import { makeScheduleCandidateInterview } from '../features/recruitment/application/tools/schedule-candidate-interview';
import { slackInterviewConfirmationPresenter } from '../features/recruitment/infrastructure/handlers/interview-confirm';

import { DrizzleDirectoryRepository } from '../features/directory/infrastructure/repositories/drizzle-directory.repository';
import { SlackMemberSource } from '../features/directory/infrastructure/providers/slack-member-source.adapter';
import { SlackChannelAccess } from '../features/directory/infrastructure/providers/slack-channel-access.adapter';
import { makeDirectorySync } from '../features/directory/application/services/directory-sync.service';
import { makeChannelCoverage } from '../features/directory/application/services/channel-coverage.service';

import { DrizzleBotMemoryRepository } from '../features/knowledge/infrastructure/repositories/drizzle-bot-memory.repository';
import { SlackChannelHistoryAdapter } from '../features/knowledge/infrastructure/providers/slack-channel-history.adapter';
import { makeGetUserConversations } from '../features/knowledge/application/tools/get-user-conversations';
import { makeGetChannelHistory } from '../features/knowledge/application/tools/get-channel-history';
import { makeSearchKnowledge } from '../features/knowledge/application/tools/search-knowledge';
import { DrizzleMessageArchiveRepository } from '../features/knowledge/infrastructure/repositories/drizzle-message-archive.repository';
import { DrizzleKnowledgeFactRepository } from '../features/knowledge/infrastructure/repositories/drizzle-knowledge-fact.repository';
import { makeFindExpertise } from '../features/knowledge/application/tools/find-expertise';

import { SmtpAdapter } from '../features/notification/infrastructure/providers/smtp.adapter';
import { createEmailProvider } from '../features/notification/infrastructure/providers/email-provider.factory';
import { SlackAdapter } from '../features/notification/infrastructure/providers/slack.adapter';
import { SlackWorkspaceService } from '../features/notification/infrastructure/providers/slack-workspace.service';
import { PdfmakeService } from '../features/document/infrastructure/services/pdfmake.service';
import { DocxService } from '../features/document/infrastructure/services/docx.service';

import { createEmployeeOnboardingWorkflow } from '../features/onboarding/application/workflows/employee-onboarding';

import { slackEventsRoute, slackEventsWorkRoute } from '../api/slack-events.route';
import { remindersDispatchRoute } from '../api/reminders-dispatch.route';
import {
  slackInteractionsRoute,
  slackInteractionsWorkRoute,
} from '../api/slack-interactions.route';
import { createApiAuthConfig } from '../shared/security/api-auth';
import { createCallerErrorMiddleware } from '../shared/security/caller-error-mapping';
import { createToolExecutionGuard } from '../shared/security/tool-execution-guard';
import { createRequestContextGuard } from '../shared/security/request-context-guard';
import { createSecurityHeadersMiddleware } from '../shared/security/http-headers';
import { createAgentApiGuard } from '../shared/security/agent-api-guard';
import { logger } from '../shared/logger';
import { reportMissingCriticalEnv } from '../shared/startup-env-check';
import { DrizzlePendingInterviewEmailRepository } from '../features/recruitment/infrastructure/repositories/drizzle-pending-email.repository';

void healthCheck().catch((error) => {
  logger.warn('Amorçage de la connexion à la base sans succès — chaque appelant dégradera', {
    error,
  });
});

const employeeRepo = new DrizzleEmployeeRepository();
const documentRepo = new DrizzleDocumentRepository();
const notificationRepo = new DrizzleNotificationRepository();
const onboardingRepo = new DrizzleOnboardingRepository();
const interviewRepo = new DrizzleOnboardingInterviewRepository();
const channelInventoryRepo = new DrizzleChannelInventoryRepository();

const emailProvider = createEmailProvider();

console.log('ENV CHECK', {
  cwd: process.cwd(),
  emailProvider: emailProvider instanceof SmtpAdapter ? 'smtp' : 'brevo',
  hasBrevoKey: Boolean(process.env.BREVO_API_KEY),
  hasSmtpPass: Boolean(process.env.SMTP_PASS),
  env: process.env.NODE_ENV,
});
const chatProvider = new SlackAdapter(process.env.SLACK_BOT_TOKEN ?? '');
const slackWorkspace = new SlackWorkspaceService(process.env.SLACK_BOT_TOKEN ?? '');
const pdfService = new PdfmakeService();
const docxService = new DocxService();

const directoryRepo = new DrizzleDirectoryRepository();
const slackMemberSource = new SlackMemberSource(slackWorkspace);
const slackChannelAccess = new SlackChannelAccess(slackWorkspace);

export const directorySync = makeDirectorySync({
  source: slackMemberSource,
  repository: directoryRepo,
  employees: employeeRepo,
});
export const channelCoverage = makeChannelCoverage({
  source: slackChannelAccess,
  inventory: channelInventoryRepo,
});

const findEmployeeByEmail = makeFindEmployeeByEmail(employeeRepo, directoryRepo);
const findPersonByName = makeFindPersonByName(employeeRepo, directoryRepo);
const getEmployeeProfile = makeGetEmployeeProfile(employeeRepo, onboardingRepo);
const updateOnboardingStatus = makeUpdateOnboardingStatus(onboardingRepo);
const generateDocument = makeGenerateDocument({
  documentRepo,
  employeeRepo,
  renderers: [pdfService, docxService],
  fileUpload: chatProvider,
  emailProvider,
  interviewRepo,
  channelRepo: channelInventoryRepo,
});
const sendNotification = makeSendNotification(
  notificationRepo,
  employeeRepo,
  emailProvider,
  chatProvider,
  slackWorkspace,
);
const scheduleReminder = makeScheduleReminder(notificationRepo, employeeRepo);
const getNotificationHistory = makeGetNotificationHistory(notificationRepo, employeeRepo);

const findExpertise = makeFindExpertise({
  directoryRepo,
  employeeRepo,
  interviewRepo,
});

const onboardingOrchestrator = makeOnboardingOrchestrator({
  findEmployeeByEmail,
  findPersonByName,
  getEmployeeProfile,
  updateOnboardingStatus,
  generateDocument,
  findExpertise,
});

const notificationAgent = makeNotificationAgent({
  findEmployeeByEmail,
  findPersonByName,
  sendNotification,
  scheduleReminder,
  getNotificationHistory,
  getEmployeeProfile,
  findExpertise,
});

const channelHistory = new SlackChannelHistoryAdapter(process.env.SLACK_BOT_TOKEN ?? '', {
  resolveDisplayName: async (id) =>
    (await directoryRepo.findBySlackUserId(id))?.displayName ?? null,
});

const getUserConversations = makeGetUserConversations({
  directory: directoryRepo,
  memory: new DrizzleBotMemoryRepository(),
});
const getChannelHistory = makeGetChannelHistory({
  directory: directoryRepo,
  channels: channelHistory,
});

const messageArchive = new DrizzleMessageArchiveRepository();
const knowledgeFactRepo = new DrizzleKnowledgeFactRepository();

const searchKnowledge = makeSearchKnowledge({
  directory: directoryRepo,
  facts: knowledgeFactRepo,
  archive: messageArchive,
  channels: channelHistory,
});

const knowledgeAgent = makeKnowledgeAgent({
  searchKnowledge,
  getUserConversations,
  getChannelHistory,
  findExpertise,
  findPersonByName,
});

const pendingInterviewEmailRepo = new DrizzlePendingInterviewEmailRepository();

const scheduleCandidateInterview = makeScheduleCandidateInterview({
  chat: { sendText: (channelId, text) => chatProvider.sendMessage(channelId, text) },
  pending: pendingInterviewEmailRepo,
  presenter: slackInterviewConfirmationPresenter,
  directoryRepo,
});

const recruitmentAgent = makeRecruitmentAgent({ scheduleCandidateInterview });

const employeeOnboardingWorkflow = createEmployeeOnboardingWorkflow({
  employeeRepo,
  onboardingRepo,
  notificationRepo,
  emailProvider,
  slackProvider: slackWorkspace,
});

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('CRITICAL: DATABASE_URL is required in production environment.');
}

reportMissingCriticalEnv(process.env, logger);

export const mastra = new Mastra({
  deployer: new VercelDeployer(),
  agents: {
    onboardingOrchestrator,
    notificationAgent,
    knowledgeAgent,
    recruitmentAgent,
  },
  workflows: {
    employeeOnboardingWorkflow,
  },
  storage: new LibSQLStore({
    id: 'mastra-store',
    url: databaseUrl,
    authToken: process.env.DATABASE_AUTH_TOKEN,
  }),
  server: {
    apiRoutes: [
      slackEventsRoute,
      slackEventsWorkRoute,
      remindersDispatchRoute,
      slackInteractionsRoute,
      slackInteractionsWorkRoute,
    ],
    middleware: [
      { path: '*', handler: createSecurityHeadersMiddleware() },
      {
        path: '/api/*',
        handler: createToolExecutionGuard({
          onReject: (path) => logger.error("Exécution d'outil par HTTP refusée", { path }),
        }),
      },
      {
        path: '/api/*',
        handler: createRequestContextGuard({
          onReject: (keys) =>
            logger.error('requestContext forgé refusé sur /api/*', { keys: keys.join(',') }),
        }),
      },
      {
        path: '/api/*',
        handler: createAgentApiGuard({
          onRefused: (types) =>
            logger.error("Tentative d'extraction du prompt refusée sur /api/agents", {
              types: types.join(','),
            }),
          onRedacted: (what) =>
            logger.warn('Fuite de configuration rédigée sur /api/agents', { what }),
        }),
      },
      {
        path: '/api/*',
        handler: createCallerErrorMiddleware({
          onRemap: (message) => logger.info('Caller error requalifiée 500→400', { message }),
        }),
      },
    ],
    cors: { origin: [], credentials: false },
    auth: createApiAuthConfig({
      onMisconfigured: (message) => logger.error(message),
    }),
  },
});

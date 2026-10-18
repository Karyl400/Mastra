import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({
  path: path.resolve(process.cwd(), '.env'),
});
import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { VercelDeployer } from '@mastra/deployer-vercel';

import { healthCheck } from '../infrastructure/database/connection';

import { makeOnboardingOrchestrator } from '../features/onboarding/application/agents/onboarding-orchestrator';
import { makeNotificationAgent } from '../features/notification/application/agents/notification-agent';
import { makeKnowledgeAgent } from '../features/knowledge/application/agents/knowledge-agent';
import { makeRecruitmentAgent } from '../features/recruitment/application/agents/recruitment-agent';

import { createEmployeeOnboardingWorkflow } from '../features/onboarding/application/workflows/employee-onboarding';
import { makeDirectorySync } from '../features/directory/application/services/directory-sync.service';
import { makeChannelCoverage } from '../features/directory/application/services/channel-coverage.service';

import { buildRuntimeDependencies } from './runtime-dependencies';
import { buildAgentTools } from './agent-tools';

import { slackEventsRoute, slackEventsWorkRoute } from '../api/slack-events.route';
import { dashboardMetricsRoute, dashboardPageRoute } from '../api/dashboard.route';
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

void healthCheck().catch((error) => {
  logger.warn('Amorçage de la connexion à la base sans succès — chaque appelant dégradera', {
    error,
  });
});

const deps = buildRuntimeDependencies();

export const directorySync = makeDirectorySync({
  source: deps.slackMemberSource,
  repository: deps.directoryRepo,
  employees: deps.employeeRepo,
});
export const channelCoverage = makeChannelCoverage({
  source: deps.slackChannelAccess,
  inventory: deps.channelInventoryRepo,
});

const {
  findEmployeeByEmail,
  findPersonByName,
  getEmployeeProfile,
  updateOnboardingStatus,
  generateDocument,
  sendNotification,
  scheduleReminder,
  getNotificationHistory,
  findExpertise,
  getUserConversations,
  getChannelHistory,
  searchKnowledge,
  listChannels,
  scheduleCandidateInterview,
} = buildAgentTools(deps);

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

const knowledgeAgent = makeKnowledgeAgent({
  searchKnowledge,
  getUserConversations,
  getChannelHistory,
  listChannels,
  findExpertise,
  findPersonByName,
});

const recruitmentAgent = makeRecruitmentAgent({ scheduleCandidateInterview });

const employeeOnboardingWorkflow = createEmployeeOnboardingWorkflow({
  employeeRepo: deps.employeeRepo,
  onboardingRepo: deps.onboardingRepo,
  notificationRepo: deps.notificationRepo,
  emailProvider: deps.emailProvider,
  slackProvider: deps.slackWorkspace,
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
      dashboardPageRoute,
      dashboardMetricsRoute,
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

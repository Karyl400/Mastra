import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { VercelDeployer } from '@mastra/deployer-vercel';

import { DrizzleEmployeeRepository } from '../features/employee/infrastructure/repositories/drizzle-employee.repository';
import { DrizzleTaskRepository } from '../features/employee/infrastructure/repositories/drizzle-task.repository';
import { DrizzleQuestionnaireRepository } from '../features/questionnaire/infrastructure/repositories/drizzle-questionnaire.repository';
import { DrizzleResponseRepository } from '../features/questionnaire/infrastructure/repositories/drizzle-response.repository';
import { DrizzleDocumentRepository } from '../features/document/infrastructure/repositories/drizzle-document.repository';
import { DrizzleNotificationRepository } from '../features/notification/infrastructure/repositories/drizzle-notification.repository';
import { DrizzleOnboardingRepository } from '../features/onboarding/infrastructure/repositories/drizzle-onboarding.repository';

import { getDb } from '../infrastructure/database/connection';

import { makeCreateEmployee } from '../features/employee/application/tools/create-employee';
import { makeGetEmployeeProfile } from '../features/employee/application/tools/get-employee-profile';
import { makeUpdateOnboardingStatus } from '../features/onboarding/application/tools/update-onboarding-status';
import { makeGetTaskList } from '../features/employee/application/tools/get-task-list';
import { makeGenerateQuestionnaire } from '../features/questionnaire/application/tools/generate-questionnaire';
import { makeEvaluateResponse } from '../features/questionnaire/application/tools/evaluate-response';
import { makeGenerateDocument } from '../features/document/application/tools/generate-document';
import { makeSendNotification } from '../features/notification/application/tools/send-notification';
import { makeScheduleReminder } from '../features/notification/application/tools/schedule-reminder';
import { makeGetNotificationHistory } from '../features/notification/application/tools/get-notification-history';

import { makeOnboardingOrchestrator } from '../features/onboarding/application/agents/onboarding-orchestrator';
import { makeQuestionnaireEngine } from '../features/questionnaire/application/agents/questionnaire-engine';
import { makeNotificationAgent } from '../features/notification/application/agents/notification-agent';

import { ResendAdapter } from '../features/notification/infrastructure/providers/resend.adapter';
import { SlackAdapter } from '../features/notification/infrastructure/providers/slack.adapter';
import { SlackWorkspaceService } from '../features/notification/infrastructure/providers/slack-workspace.service';
import { makeDiscoverSlackWorkspace } from '../features/notification/application/tools/discover-slack-workspace';
import { PdfmakeService } from '../features/document/infrastructure/services/pdfmake.service';

import { createEmployeeOnboardingWorkflow } from '../features/onboarding/application/workflows/employee-onboarding';
import { questionnaireCycleWorkflow } from '../features/questionnaire/application/workflows/questionnaire-cycle';
import { notificationCycleWorkflow } from '../features/notification/application/workflows/notification-cycle';
import { createDocumentWorkflow } from '../features/document/application/workflows/document-generation';

// La connexion DB est établie à la première requête (lazy init via getConnectionManager)
// getDb() appelé ici forcerait l'ouverture au démarrage — inutile en dev

const employeeRepo = new DrizzleEmployeeRepository();
const taskRepo = new DrizzleTaskRepository();
const questionnaireRepo = new DrizzleQuestionnaireRepository();
const responseRepo = new DrizzleResponseRepository();
const documentRepo = new DrizzleDocumentRepository();
const notificationRepo = new DrizzleNotificationRepository();
const onboardingRepo = new DrizzleOnboardingRepository();

console.log('DEBUG ENV', {
  cwd: process.cwd(),
  resend: process.env.RESEND_API_KEY,
  env: process.env.NODE_ENV,
});

const emailProvider = new ResendAdapter(
  process.env.RESEND_API_KEY ?? '',
  process.env.NOTIFICATION_FROM ?? 'noreply@kisso.com',
);
const chatProvider = new SlackAdapter(process.env.SLACK_BOT_TOKEN ?? '');
const slackWorkspace = new SlackWorkspaceService(process.env.SLACK_BOT_TOKEN ?? '');
const pdfService = new PdfmakeService();

const createEmployee = makeCreateEmployee(employeeRepo);
const getEmployeeProfile = makeGetEmployeeProfile(employeeRepo, onboardingRepo, taskRepo);
const updateOnboardingStatus = makeUpdateOnboardingStatus(onboardingRepo);
const getTaskList = makeGetTaskList(taskRepo);
const generateQuestionnaire = makeGenerateQuestionnaire(questionnaireRepo);
const evaluateResponse = makeEvaluateResponse(questionnaireRepo, responseRepo);
const generateDocument = makeGenerateDocument(documentRepo);
const sendNotification = makeSendNotification(notificationRepo, emailProvider, chatProvider);
const scheduleReminder = makeScheduleReminder(notificationRepo);
const getNotificationHistory = makeGetNotificationHistory(notificationRepo);
const discoverSlackWorkspace = makeDiscoverSlackWorkspace(slackWorkspace);

const onboardingOrchestrator = makeOnboardingOrchestrator({
  createEmployee,
  getEmployeeProfile,
  updateOnboardingStatus,
  getTaskList,
  generateDocument,
  discoverSlackWorkspace,
});

const questionnaireEngine = makeQuestionnaireEngine({
  generateQuestionnaire,
  evaluateResponse,
  getEmployeeProfile,
});

const notificationAgent = makeNotificationAgent({
  sendNotification,
  scheduleReminder,
  getNotificationHistory,
  getEmployeeProfile,
  discoverSlackWorkspace,
});

const documentGenerationWorkflow = createDocumentWorkflow({
  employeeRepo,
  pdfService,
});

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

export const mastra = new Mastra({
  deployer: new VercelDeployer(),
  agents: {
    onboardingOrchestrator,
    questionnaireEngine,
    notificationAgent,
  },
  workflows: {
    employeeOnboardingWorkflow,
    questionnaireCycleWorkflow,
    notificationCycleWorkflow,
    documentGenerationWorkflow,
  },
  storage: new LibSQLStore({
    id: 'mastra-store',
    url: databaseUrl,
    authToken: process.env.DATABASE_AUTH_TOKEN,
  }),
});

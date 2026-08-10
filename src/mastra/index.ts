import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({
  path: path.resolve(process.cwd(), '.env'),
});
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
import { makeFindEmployeeByEmail } from '../features/employee/application/tools/find-employee-by-email';
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

import { BrevoAdapter } from '../features/notification/infrastructure/providers/brevo.adapter';
import { SmtpAdapter } from '../features/notification/infrastructure/providers/smtp.adapter';
import type { EmailProvider } from '../features/notification/domain/ports/providers';
import { SlackAdapter } from '../features/notification/infrastructure/providers/slack.adapter';
import { SlackWorkspaceService } from '../features/notification/infrastructure/providers/slack-workspace.service';
import { PdfmakeService } from '../features/document/infrastructure/services/pdfmake.service';

import { createEmployeeOnboardingWorkflow } from '../features/onboarding/application/workflows/employee-onboarding';
import { questionnaireCycleWorkflow } from '../features/questionnaire/application/workflows/questionnaire-cycle';
import { notificationCycleWorkflow } from '../features/notification/application/workflows/notification-cycle';
import { createDocumentWorkflow } from '../features/document/application/workflows/document-generation';

import { slackEventsRoute } from '../api/slack-events.route';
import { slackInteractionsRoute } from '../api/slack-interactions.route';
import { createApiAuthConfig } from '../shared/security/api-auth';
import { createCallerErrorMiddleware } from '../shared/security/caller-error-mapping';
import { logger } from '../shared/logger';

// La connexion DB est établie à la première requête (lazy init via getConnectionManager)
// getDb() appelé ici forcerait l'ouverture au démarrage — inutile en dev

const employeeRepo = new DrizzleEmployeeRepository();
const taskRepo = new DrizzleTaskRepository();
const questionnaireRepo = new DrizzleQuestionnaireRepository();
const responseRepo = new DrizzleResponseRepository();
const documentRepo = new DrizzleDocumentRepository();
const notificationRepo = new DrizzleNotificationRepository();
const onboardingRepo = new DrizzleOnboardingRepository();

/**
 * Sélection du fournisseur email.
 *
 * SMTP l'emporte dès que `SMTP_HOST`, `SMTP_USER` et `SMTP_PASS` sont tous renseignés,
 * sinon on retombe sur Brevo. Raison : le compte transactionnel Brevo n'est pas activé
 * (`403 permission_denied` sur `POST /v3/smtp/email`, y compris avec un expéditeur
 * pourtant validé), donc SMTP est aujourd'hui le seul chemin qui envoie réellement.
 *
 * ⚠️ Gmail : `SMTP_PASS` doit être un mot de passe d'APPLICATION (16 caractères), pas
 * le mot de passe du compte — sinon `534-5.7.9 Application-specific password required`.
 */
function createEmailProvider(): EmailProvider {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.NOTIFICATION_FROM;

  if (host && user && pass) {
    return new SmtpAdapter({
      host,
      port: Number(process.env.SMTP_PORT ?? 587),
      user,
      pass,
      from: from || user,
      fromName: 'Kisso Onboarding',
    });
  }

  return new BrevoAdapter(process.env.BREVO_API_KEY ?? '', from ?? 'noreply@kissohq.com');
}

const emailProvider = createEmailProvider();

// Ne JAMAIS logger la valeur d'une clé d'API — uniquement sa présence.
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

const createEmployee = makeCreateEmployee(employeeRepo);
const findEmployeeByEmail = makeFindEmployeeByEmail(employeeRepo);
const getEmployeeProfile = makeGetEmployeeProfile(employeeRepo, onboardingRepo, taskRepo);
const updateOnboardingStatus = makeUpdateOnboardingStatus(onboardingRepo);
const getTaskList = makeGetTaskList(taskRepo);
const generateQuestionnaire = makeGenerateQuestionnaire(questionnaireRepo);
const evaluateResponse = makeEvaluateResponse(questionnaireRepo, responseRepo);
const generateDocument = makeGenerateDocument(documentRepo);
const sendNotification = makeSendNotification(
  notificationRepo,
  employeeRepo,
  emailProvider,
  chatProvider,
  slackWorkspace,
);
const scheduleReminder = makeScheduleReminder(notificationRepo);
const getNotificationHistory = makeGetNotificationHistory(notificationRepo);

// `discoverSlackWorkspace` a été retiré : il n'est mentionné dans AUCUNE instruction de
// l'agent (vérifié par grep), et son schéma était le poste de coût le plus lourd après
// `createEmployee`. Même raisonnement que pour `notificationAgent`, appliqué ici par
// cohérence. L'invitation Slack du parcours d'onboarding ne passe pas par ce tool mais par
// `deps.slackProvider` dans l'étape `inviteToSlack` de `employeeOnboardingWorkflow`.
// Le tool reste câblé et testé isolément — seule son exposition à cet agent est retirée.
const onboardingOrchestrator = makeOnboardingOrchestrator({
  createEmployee,
  findEmployeeByEmail,
  getEmployeeProfile,
  updateOnboardingStatus,
  getTaskList,
  generateDocument,
});

const questionnaireEngine = makeQuestionnaireEngine({
  generateQuestionnaire,
  evaluateResponse,
  getEmployeeProfile,
});

// discoverSlackWorkspace n'est PAS exposé ici : les instructions de l'agent ne le
// mentionnent jamais (sendNotification résout déjà le compte Slack côté serveur), et
// c'est actuellement le tool le plus coûteux en tokens du set (~356 caractères de
// schéma JSON + 426 de description). Voir CHANGELOG pour la mesure avant/après.
const notificationAgent = makeNotificationAgent({
  sendNotification,
  scheduleReminder,
  getNotificationHistory,
  getEmployeeProfile,
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
  // Une route HTTP n'existe QUE si elle est déclarée ici. Les fichiers de `src/api/`
  // ne sont jamais montés automatiquement par Mastra.
  server: {
    apiRoutes: [slackEventsRoute, slackInteractionsRoute],
    // Requalifie en 400 les erreurs de validation d'entrée que Mastra renvoie en 500.
    // Monté sur `/api/*` UNIQUEMENT : `/slack/events` gère ses propres codes et le rejeu
    // de Slack en dépend. Une vraie panne serveur reste un 500 (voir le module).
    middleware: [
      {
        path: '/api/*',
        handler: createCallerErrorMiddleware({
          onRemap: (message) => logger.info('Caller error requalifiée 500→400', { message }),
        }),
      },
    ],
    // Sans `auth`, `getEffectiveAuthConfig()` renvoie null et `checkRouteAuth()` laisse
    // passer TOUTES les routes /api/* sans authentification — n'importe qui sur Internet
    // pilotait les agents (envoi d'email, création d'employés, publication Slack).
    // `/slack/events` reste exempt via son `requiresAuth: false` (vérifié dans le source
    // de @mastra/server) et s'authentifie par signature HMAC Slack.
    auth: createApiAuthConfig({
      onMisconfigured: (message) => logger.error(message),
    }),
  },
});

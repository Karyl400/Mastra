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
import { DocxService } from '../features/document/infrastructure/services/docx.service';

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
/**
 * Renderers de documents — c'est CE câblage qui fait entrer `docx` dans le bundle.
 *
 * `DocxService` importe `docx` statiquement : tant qu'aucun module atteignable depuis ce
 * fichier ne le référençait, le bundler Mastra/Vercel ne l'embarquait pas. Le garde-fou
 * `verify:bundle` exige désormais sa présence (`--require …,docx` dans package.json) —
 * les deux vont ensemble, ajouter l'exigence sans ce câblage casserait le build.
 */
const docxService = new DocxService();

const findEmployeeByEmail = makeFindEmployeeByEmail(employeeRepo);
const getEmployeeProfile = makeGetEmployeeProfile(employeeRepo, onboardingRepo, taskRepo);
const updateOnboardingStatus = makeUpdateOnboardingStatus(onboardingRepo);
// L'annuaire est le SECOND paramètre, et il n'est pas décoratif : sans lui, un UUID inconnu
// rend `{tasks: [], totalTasks: 0}` — indiscernable d'un employé réellement sans tâche. Le
// modèle affirmait alors « aucune tâche en cours » pour un identifiant qui ne désigne personne.
const getTaskList = makeGetTaskList(taskRepo, employeeRepo);
const generateQuestionnaire = makeGenerateQuestionnaire(questionnaireRepo);
const evaluateResponse = makeEvaluateResponse(questionnaireRepo, responseRepo);
// `generateDocument` ne se contente plus d'écrire une ligne : il rend le fichier, le
// livre dans Slack (upload) ou par email (pièce jointe), et rend compte de la livraison.
// Le canal et le thread ne sont PAS injectés ici — ils viennent du `requestContext` par
// requête (`src/shared/slack-request-context.ts`) ; l'adresse email, elle, est résolue
// depuis l'annuaire. Aucune destination ne transite par le modèle.
const generateDocument = makeGenerateDocument({
  documentRepo,
  employeeRepo,
  renderers: [pdfService, docxService],
  // `SlackAdapter` porte `uploadFile` en plus de `sendMessage` : un seul WebClient, un
  // seul jeton. Le scope `files:write` EST accordé — vérifié en production le 2026-08-11,
  // un PDF réellement posté dans un DM (`hasPermalink: true` dans les logs). L'ancienne
  // note affirmant le contraire a survécu à sa propre invalidation pendant une journée.
  fileUpload: chatProvider,
  emailProvider,
});
const sendNotification = makeSendNotification(
  notificationRepo,
  employeeRepo,
  emailProvider,
  chatProvider,
  slackWorkspace,
);
// Même raison que `getTaskList` : l'annuaire permet de refuser un destinataire inexistant
// AVANT d'enregistrer un rappel. Sans lui le tool dégrade — il ne ment pas, mais il accepte.
const scheduleReminder = makeScheduleReminder(notificationRepo, employeeRepo);
const getNotificationHistory = makeGetNotificationHistory(notificationRepo);

// `discoverSlackWorkspace` a été retiré : il n'est mentionné dans AUCUNE instruction de
// l'agent (vérifié par grep), et son schéma était le poste de coût le plus lourd après
// `createEmployee`. Même raisonnement que pour `notificationAgent`, appliqué ici par
// cohérence. L'invitation Slack du parcours d'onboarding ne passe pas par ce tool mais par
// `deps.slackProvider` dans l'étape `inviteToSlack` de `employeeOnboardingWorkflow`.
// Le tool reste câblé et testé isolément — seule son exposition à cet agent est retirée.
// `createEmployee` a été retiré le 2026-08-11, après la campagne de tests en
// production. Exposer une allowlist fermée (`department`, `position`) à un LLM ne
// protège pas l'intégrité des données : le modèle substitue une valeur valide
// AVANT d'appeler l'outil pour que l'appel réussisse. Mesuré : « Software
// Engineer » enregistré en « Developer », et « Plomberie » enregistré en
// « Engineering » — ce dernier SANS le moindre avertissement. La validation Zod
// n'a jamais vu les valeurs refusées.
// La création passe désormais par la modale du flux d'arrivée : liste déroulante
// côté Slack, workflow appelé en code, aucun LLM sur le chemin transactionnel.
// Le tool reste câblé pour l'API et le workflow.
const onboardingOrchestrator = makeOnboardingOrchestrator({
  findEmployeeByEmail,
  getEmployeeProfile,
  updateOnboardingStatus,
  getTaskList,
  generateDocument,
});

// `findEmployeeByEmail` est exposé aux TROIS agents depuis le 2026-08-11, et c'est un
// correctif de CÂBLAGE, pas de rédaction.
//
// Tous les tools de `questionnaireEngine` et de `notificationAgent` exigent un UUID
// d'employé, et AUCUN ne sait faire email → UUID : ce tool n'était câblé que sur
// l'orchestrateur. Pire, le `.describe()` de `recipientId` renvoyait vers
// `getEmployeeProfile`, qui exige déjà un UUID — la consigne était circulaire. Et
// `AGENT_ANTI_INVENTION_BLOCK` interdit au modèle d'en deviner un. La boucle infernale de la
// série C (« donne-moi son identifiant » → « je ne l'ai pas » → …) était donc GARANTIE par le
// câblage, pas probabiliste : c'est la répétition du bug du 2026-08-10, corrigé côté routage
// et jamais côté outillage.
//
// Coût mesuré : ≈ +120 tokens de schéma par agent, repayés à chaque aller-retour. Assumé —
// un agent qui ne peut pas résoudre une personne ne peut RIEN faire, quel que soit son prix.
const questionnaireEngine = makeQuestionnaireEngine({
  findEmployeeByEmail,
  generateQuestionnaire,
  evaluateResponse,
  getEmployeeProfile,
});

// discoverSlackWorkspace n'est PAS exposé ici : les instructions de l'agent ne le
// mentionnent jamais (sendNotification résout déjà le compte Slack côté serveur), et
// c'est actuellement le tool le plus coûteux en tokens du set (~356 caractères de
// schéma JSON + 426 de description). Voir CHANGELOG pour la mesure avant/après.
const notificationAgent = makeNotificationAgent({
  // Voir le commentaire de `questionnaireEngine` ci-dessus : sans ce tool, les quatre autres
  // sont inatteignables dès que l'humain désigne quelqu'un par son email — c'est-à-dire
  // presque toujours.
  findEmployeeByEmail,
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
  taskRepo,
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

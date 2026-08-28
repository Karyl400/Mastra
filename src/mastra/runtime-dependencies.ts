import { DrizzleEmployeeRepository } from '../features/employee/infrastructure/repositories/drizzle-employee.repository';
import { DrizzleDocumentRepository } from '../features/document/infrastructure/repositories/drizzle-document.repository';
import { DrizzleNotificationRepository } from '../features/notification/infrastructure/repositories/drizzle-notification.repository';
import { DrizzleOnboardingRepository } from '../features/onboarding/infrastructure/repositories/drizzle-onboarding.repository';
import { DrizzleOnboardingInterviewRepository } from '../features/onboarding/infrastructure/repositories/drizzle-onboarding-interview.repository';
import { DrizzleChannelInventoryRepository } from '../features/directory/infrastructure/repositories/drizzle-channel.repository';
import { DrizzleDirectoryRepository } from '../features/directory/infrastructure/repositories/drizzle-directory.repository';
import { DrizzleBotMemoryRepository } from '../features/knowledge/infrastructure/repositories/drizzle-bot-memory.repository';
import { DrizzleMessageArchiveRepository } from '../features/knowledge/infrastructure/repositories/drizzle-message-archive.repository';
import { DrizzleKnowledgeFactRepository } from '../features/knowledge/infrastructure/repositories/drizzle-knowledge-fact.repository';
import { DrizzlePendingInterviewEmailRepository } from '../features/recruitment/infrastructure/repositories/drizzle-pending-email.repository';

import { SlackMemberSource } from '../features/directory/infrastructure/providers/slack-member-source.adapter';
import { SlackChannelAccess } from '../features/directory/infrastructure/providers/slack-channel-access.adapter';
import { SlackChannelHistoryAdapter } from '../features/knowledge/infrastructure/providers/slack-channel-history.adapter';
import { SmtpAdapter } from '../features/notification/infrastructure/providers/smtp.adapter';
import { createEmailProvider } from '../features/notification/infrastructure/providers/email-provider.factory';
import { SlackAdapter } from '../features/notification/infrastructure/providers/slack.adapter';
import { SlackWorkspaceService } from '../features/notification/infrastructure/providers/slack-workspace.service';
import { PdfmakeService } from '../features/document/infrastructure/services/pdfmake.service';
import { DocxService } from '../features/document/infrastructure/services/docx.service';

export function buildRuntimeDependencies() {
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

  const channelHistory = new SlackChannelHistoryAdapter(process.env.SLACK_BOT_TOKEN ?? '', {
    resolveDisplayName: async (id) =>
      (await directoryRepo.findBySlackUserId(id))?.displayName ?? null,
  });

  const botMemory = new DrizzleBotMemoryRepository();
  const messageArchive = new DrizzleMessageArchiveRepository();
  const knowledgeFactRepo = new DrizzleKnowledgeFactRepository();
  const pendingInterviewEmailRepo = new DrizzlePendingInterviewEmailRepository();

  return {
    employeeRepo,
    documentRepo,
    notificationRepo,
    onboardingRepo,
    interviewRepo,
    channelInventoryRepo,
    emailProvider,
    chatProvider,
    slackWorkspace,
    pdfService,
    docxService,
    directoryRepo,
    slackMemberSource,
    slackChannelAccess,
    channelHistory,
    botMemory,
    messageArchive,
    knowledgeFactRepo,
    pendingInterviewEmailRepo,
  };
}

export type RuntimeDependencies = ReturnType<typeof buildRuntimeDependencies>;

import type { Mastra } from '@mastra/core';

import { DrizzleNotificationRepository } from '../features/notification/infrastructure/repositories/drizzle-notification.repository';
import {
  SlackEventsHandler,
  type SlackEventsHandlerOptions,
} from '../features/notification/infrastructure/handlers/slack-events.handler';
import { SlackWorkspaceService } from '../features/notification/infrastructure/providers/slack-workspace.service';
import { makeWelcomeChannels } from '../features/directory/application/services/welcome-channels.service';
import { SlackWelcomeChannelSource } from '../features/directory/infrastructure/providers/slack-welcome-channel.adapter';
import { parseWelcomeChannelNames } from '../features/directory/domain/services/welcome-channel-names';
import { DrizzleOnboardingInterviewRepository } from '../features/onboarding/infrastructure/repositories/drizzle-onboarding-interview.repository';
import { DrizzleEmployeeRepository } from '../features/employee/infrastructure/repositories/drizzle-employee.repository';
import { DrizzlePendingInterviewEmailRepository } from '../features/recruitment/infrastructure/repositories/drizzle-pending-email.repository';
import { KnowledgeErasureService } from '../features/knowledge/application/services/knowledge-erasure.service';
import { KnowledgeIngestionService } from '../features/knowledge/application/services/knowledge-ingestion.service';
import { ModelFactSummarizer } from '../features/knowledge/infrastructure/services/model-fact-summarizer.service';
import { DrizzleMessageArchiveRepository } from '../features/knowledge/infrastructure/repositories/drizzle-message-archive.repository';
import { DrizzleKnowledgeFactRepository } from '../features/knowledge/infrastructure/repositories/drizzle-knowledge-fact.repository';
import { createEmailProvider } from '../features/notification/infrastructure/providers/email-provider.factory';

let cachedHandler: SlackEventsHandler | undefined;
let cachedMastra: Mastra | undefined;

let handlerOptionsForTests: SlackEventsHandlerOptions | undefined;

let cachedEventsEmailProvider: ReturnType<typeof createEmailProvider> | undefined;

function getEventsEmailProvider() {
  cachedEventsEmailProvider ??= createEmailProvider();
  return cachedEventsEmailProvider;
}

function buildWelcomeChannels(botToken: string) {
  return makeWelcomeChannels({
    source: new SlackWelcomeChannelSource(new SlackWorkspaceService(botToken)),
    channelNames: parseWelcomeChannelNames(process.env.ONBOARDING_WELCOME_CHANNELS),
  });
}

export function getSlackEventsHandler(mastra: Mastra): SlackEventsHandler {
  if (!cachedHandler || cachedMastra !== mastra) {
    const botToken = process.env.SLACK_BOT_TOKEN ?? '';
    const knowledgeArchiveRepo = new DrizzleMessageArchiveRepository();
    const knowledgeFactRepo = new DrizzleKnowledgeFactRepository();
    cachedHandler = new SlackEventsHandler(botToken, mastra, {
      welcomeChannels: buildWelcomeChannels(botToken),
      interviewRepository: new DrizzleOnboardingInterviewRepository(),
      profileRepository: new DrizzleEmployeeRepository(),
      pendingEmailRepository: new DrizzlePendingInterviewEmailRepository(),
      notificationRepository: new DrizzleNotificationRepository(),
      knowledgeErasure: new KnowledgeErasureService({
        archive: knowledgeArchiveRepo,
        facts: knowledgeFactRepo,
      }),
      knowledgeIngestion: new KnowledgeIngestionService({
        archive: knowledgeArchiveRepo,
        facts: knowledgeFactRepo,
        summarizer: new ModelFactSummarizer(),
      }),
      sendEmail: (to, subject, body) => getEventsEmailProvider().sendEmail(to, subject, body),
      ...handlerOptionsForTests,
    });
    cachedMastra = mastra;
  }
  return cachedHandler;
}

export function setSlackEventsHandlerOptionsForTests(
  options: SlackEventsHandlerOptions | undefined,
): void {
  handlerOptionsForTests = options;
  cachedHandler = undefined;
  cachedMastra = undefined;
}

export function resetSlackEventsHandler(): void {
  cachedHandler = undefined;
  cachedMastra = undefined;
  handlerOptionsForTests = undefined;
}

import { makeFindEmployeeByEmail } from '../features/employee/application/tools/find-employee-by-email';
import { makeFindPersonByName } from '../features/employee/application/tools/find-person-by-name';
import { makeGetEmployeeProfile } from '../features/employee/application/tools/get-employee-profile';
import { makeUpdateOnboardingStatus } from '../features/onboarding/application/tools/update-onboarding-status';
import { makeGenerateDocument } from '../features/document/application/tools/generate-document';
import { makeSendNotification } from '../features/notification/application/tools/send-notification';
import { makeScheduleReminder } from '../features/notification/application/tools/schedule-reminder';
import { makeGetNotificationHistory } from '../features/notification/application/tools/get-notification-history';
import { makeGetUserConversations } from '../features/knowledge/application/tools/get-user-conversations';
import { makeGetChannelHistory } from '../features/knowledge/application/tools/get-channel-history';
import { makeSearchKnowledge } from '../features/knowledge/application/tools/search-knowledge';
import { makeListChannels } from '../features/knowledge/application/tools/list-channels';
import { makeFindExpertise } from '../features/knowledge/application/tools/find-expertise';
import { makeScheduleCandidateInterview } from '../features/recruitment/application/tools/schedule-candidate-interview';
import { slackInterviewConfirmationPresenter } from '../features/recruitment/infrastructure/handlers/interview-confirm';
import type { DigestDeliveryPort } from '../features/knowledge/domain/ports/digest-delivery.port';
import { DocumentType } from '../shared/types';
import { logger } from '../shared/logger';
import type { RuntimeDependencies } from './runtime-dependencies';

function makeChannelDigestDelivery(
  pdfService: RuntimeDependencies['pdfService'],
  chatProvider: RuntimeDependencies['chatProvider'],
): DigestDeliveryPort {
  return {
    async deliver(digest, target) {
      const rendered = await pdfService.render({
        type: DocumentType.Guide,
        title: digest.title,
        content: [digest.coverage, '', ...digest.lines].filter(Boolean).join('\n'),
      });

      try {
        await chatProvider.uploadFile({
          channel: target.channel,
          ...(target.threadTs ? { threadTs: target.threadTs } : {}),
          bytes: rendered.bytes,
          filename: rendered.filename,
          title: digest.title,
        });
      } catch (error) {
        logger.error('Livraison du résumé de canal en document impossible', {
          channelId: digest.channelId,
          error,
        });
        return { delivered: false, reason: 'post_failed' };
      }

      return { delivered: true, filename: rendered.filename };
    },
  };
}

export function buildAgentTools(deps: RuntimeDependencies) {
  const {
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
    channelHistory,
    botMemory,
    messageArchive,
    knowledgeFactRepo,
    pendingInterviewEmailRepo,
  } = deps;

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

  const getUserConversations = makeGetUserConversations({
    directory: directoryRepo,
    memory: botMemory,
  });

  const channelDigestDelivery = makeChannelDigestDelivery(pdfService, chatProvider);

  const getChannelHistory = makeGetChannelHistory({
    directory: directoryRepo,
    channels: channelHistory,
    digests: channelDigestDelivery,
  });

  const searchKnowledge = makeSearchKnowledge({
    directory: directoryRepo,
    facts: knowledgeFactRepo,
    archive: messageArchive,
    channels: channelHistory,
  });

  const listChannels = makeListChannels({
    directory: directoryRepo,
    channels: channelHistory,
  });

  const scheduleCandidateInterview = makeScheduleCandidateInterview({
    chat: { sendText: (channelId, text) => chatProvider.sendMessage(channelId, text) },
    pending: pendingInterviewEmailRepo,
    presenter: slackInterviewConfirmationPresenter,
    directoryRepo,
  });

  return {
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
  };
}

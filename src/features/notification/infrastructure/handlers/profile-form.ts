import { logger } from '../../../../shared/logger';
import {
  PROFILE_FORM_CHANNEL_REDIRECT,
  PROFILE_FORM_INVITE,
} from '../../../../shared/profile-request';
import {
  PROFILE_ALREADY_COMPLETE,
  PROFILE_QUESTIONS,
  nextProfileStep,
} from '../../../onboarding/domain/services/profile-chat';
import { buildProfileInviteBlocks } from '../ui/welcome-blocks';
import type { SlackHandlerInternals } from './handler-internals';
import { sayAndRemember } from './conversation-memory';
import { knownProfileAnswers } from './profile-record';

export async function runProfileForm(
  self: SlackHandlerInternals,
  ctx: {
    channel: string;
    threadTs?: string;
    isDirectMessage: boolean;
    conversationId: string;
    user?: string;
  },
): Promise<void> {
  const { channel, threadTs, isDirectMessage, conversationId, user } = ctx;
  if (!isDirectMessage) {
    logger.info('Profile form requested in a channel — redirected to DM, no LLM call', {
      channel,
    });
    await self.slack.chat.postMessage({
      channel,
      text: PROFILE_FORM_CHANNEL_REDIRECT,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    return;
  }

  const known = await knownProfileAnswers(self, user);
  const first = nextProfileStep(known);

  if (!first) {
    await sayAndRemember(
      self,
      { channel, threadTs, conversationId, user },
      PROFILE_ALREADY_COMPLETE,
    );
    return;
  }

  await self.chatProvider.sendBlocks(channel, PROFILE_FORM_INVITE, buildProfileInviteBlocks());

  await sayAndRemember(self, { channel, threadTs, conversationId, user }, PROFILE_QUESTIONS[first]);

  logger.info('Profile form posted — answered without any LLM call', { channel, first });
}

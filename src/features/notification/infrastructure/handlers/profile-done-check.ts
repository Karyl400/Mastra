import { logger } from '../../../../shared/logger';
import type { ConversationTurn } from '../../../conversation/domain/entities/conversation-turn';
import { DEFAULT_AGENT_ID } from '../../domain/services/agent-routing';
import { findActingReply } from '../../domain/services/deterministic-replies';
import {
  PROFILE_CHECK_UNAVAILABLE,
  verifyProfile,
} from '../../../onboarding/domain/services/profile-completion';
import {
  answersFromDirectory,
  answersFromRecord,
  collectProfileAnswers,
  nextProfileStep,
  type ProfileAnswers,
} from '../../../onboarding/domain/services/profile-chat';
import type { SlackHandlerInternals } from './handler-internals';
import { rememberTurn } from './conversation-memory';
import { findProfileRecord } from './profile-record';
import { submitProfile } from './profile-journey';

export interface ProfileDoneInput {
  history: readonly ConversationTurn[];
  isDirectMessage: boolean;
  text: string;
  channel: string;
  threadTs: string | undefined;
  conversationId: string;
  user: string | undefined;
}

export async function maybeCheckProfileDone(
  self: SlackHandlerInternals,
  input: ProfileDoneInput,
): Promise<boolean> {
  const acting = findActingReply({ text: input.text, isDirectMessage: input.isDirectMessage });
  if (acting?.action !== 'profile_done') {
    return false;
  }

  await runProfileDoneCheck(self, input);
  return true;
}

async function runProfileDoneCheck(
  self: SlackHandlerInternals,
  input: ProfileDoneInput,
): Promise<void> {
  const { history, text, channel, threadTs, conversationId, user } = input;

  let reply: string;
  try {
    const member = user ? await self.getDirectoryRepo()?.findBySlackUserId(user) : null;
    const record = await findProfileRecord(self, member);

    const known: ProfileAnswers = {
      ...answersFromDirectory(member),
      ...answersFromRecord(record),
      ...collectProfileAnswers(history),
    };

    const verdict = verifyProfile(record, known);

    if (record === null && nextProfileStep(known) === null) {
      await rememberTurn(self, {
        conversationId,
        role: 'user',
        content: text,
        agentId: DEFAULT_AGENT_ID,
        slackUserId: user ?? null,
      });
      await submitProfile(
        self,
        { channel, threadTs, conversationId, user },
        known as Required<ProfileAnswers>,
      );
      return;
    }

    reply = verdict.reply;
  } catch (error) {
    logger.error('Vérification « j’ai fini » impossible — on ne l’impute pas à la personne', {
      error: String(error),
    });
    reply = PROFILE_CHECK_UNAVAILABLE;
  }

  logger.info('« J’ai fini » vérifié — aucun appel de modele', { channel });

  await self.slack.chat.postMessage({
    channel,
    text: reply,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });

  await rememberTurn(self, {
    conversationId,
    role: 'user',
    content: text,
    agentId: DEFAULT_AGENT_ID,
    slackUserId: user ?? null,
  });
  await rememberTurn(self, {
    conversationId,
    role: 'assistant',
    content: reply,
    agentId: DEFAULT_AGENT_ID,
    slackUserId: null,
  });
}

import { logger } from '../../../../shared/logger';
import { deriveConversationId } from '../../../conversation/domain/value-objects/conversation-id';
import type { ConversationTurn } from '../../../conversation/domain/entities/conversation-turn';
import { DEFAULT_AGENT_ID } from '../../domain/services/agent-routing';
import { findStaticReply, replyFor } from '../../domain/services/deterministic-replies';
import type { MessageContext, SlackHandlerInternals } from './handler-internals';
import { resolveThreadTarget, type SlackMessageEvent } from './slack-event.types';
import { cleanText } from './message-text';
import { loadHistory, rememberTurn } from './conversation-memory';
import { resolveRequesterIdentity } from './requester-identity';
import { hasPendingOnboardingQuestion } from './onboarding-turn-state';

export async function buildMessageContext(
  self: SlackHandlerInternals,
  event: SlackMessageEvent,
): Promise<MessageContext | null> {
  const { user, channel } = event;

  if (event.bot_id || event.subtype === 'bot_message') {
    logger.debug('Ignoring bot message', { botId: event.bot_id });
    return null;
  }

  if (!channel) {
    logger.warn('Slack event without channel, skipping', { user });
    return null;
  }

  const botUserId = await self.getBotUserId();
  const text = cleanText(event.text, botUserId);

  const { isDirectMessage, threadTs } = resolveThreadTarget(event, channel);

  const conversationId = deriveConversationId({ channel, threadTs });

  const requesterIdentity = resolveRequesterIdentity(self, user);

  const history = await loadHistory(self, conversationId);

  if (shouldAbandonThreadReply(event, isDirectMessage, history, botUserId)) {
    logger.info('Ignoring a channel thread reply: the bot has never spoken in this thread', {
      channel,
      threadTs,
      historyTurns: history.length,
    });
    return null;
  }

  return {
    event,
    user,
    channel,
    text,
    threadTs,
    isDirectMessage,
    conversationId,
    requesterIdentity,
    history,
  };
}

function shouldAbandonThreadReply(
  event: SlackMessageEvent,
  isDirectMessage: boolean,
  history: readonly ConversationTurn[],
  botUserId: string | undefined,
): boolean {
  if (event.type !== 'message' || isDirectMessage) return false;

  if (botUserId && (event.text ?? '').includes(`<@${botUserId}>`)) return false;

  if (!history.some((turn) => turn.role === 'assistant')) return true;

  return !history.some((turn) => turn.role === 'user' && turn.slackUserId === event.user);
}

export async function runStaticReply(
  self: SlackHandlerInternals,
  ctx: {
    input: Parameters<typeof findStaticReply>[0];
    history: readonly ConversationTurn[];
    channel: string;
    threadTs: string | undefined;
    conversationId: string;
    user: string | undefined;
  },
): Promise<boolean> {
  const { input, history, channel, threadTs, conversationId, user } = ctx;
  const staticReply = findStaticReply(input);
  const staticText = staticReply ? replyFor(staticReply, input) : null;

  if (staticReply && staticText) {
    logger.info(`Court-circuit deterministe (${staticReply.name}) — aucun appel de modele`, {
      channel,
      ...(staticReply.logFields?.(input) ?? {}),
    });

    await self.slack.chat.postMessage({
      channel,
      text: staticText,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });

    if (staticReply.remembersTurn && !hasPendingOnboardingQuestion(history)) {
      await rememberTurn(self, {
        conversationId,
        role: 'user',
        content: input.text,
        agentId: DEFAULT_AGENT_ID,
        slackUserId: user ?? null,
      });
      await rememberTurn(self, {
        conversationId,
        role: 'assistant',
        content: staticText,
        agentId: DEFAULT_AGENT_ID,
        slackUserId: null,
      });
    }
    return true;
  }

  return false;
}

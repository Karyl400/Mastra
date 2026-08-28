import { logger } from '../../../../shared/logger';
import { ERASURE_FAILED_REPLY, erasureDoneReply } from '../../../../shared/forget';
import {
  MAX_PINNED_FACTS,
  PIN_FAILED_REPLY,
  extractPinnedFact,
  pinnedFactReply,
} from '../../../../shared/pin-fact';
import type { SlackHandlerInternals } from './handler-internals';

export async function runErasure(
  self: SlackHandlerInternals,
  ctx: {
    text: string;
    channel: string;
    threadTs?: string;
    user?: string;
    conversationId: string;
    isDirectMessage: boolean;
  },
): Promise<void> {
  const { channel, threadTs, user, conversationId, isDirectMessage } = ctx;
  const scope = isDirectMessage ? { conversationId } : { conversationId, slackUserId: user };

  const repo = self.getConversationRepo();

  if (!repo || (!isDirectMessage && !user)) {
    logger.warn('Erasure requested but the scope could not be established', {
      channel,
      hasRepo: Boolean(repo),
      isDirectMessage,
    });
    await self.slack.chat.postMessage({
      channel,
      text: ERASURE_FAILED_REPLY,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    return;
  }

  try {
    const removed = await repo.forget(scope);

    let removedFacts = 0;
    if (user) {
      try {
        removedFacts = (await self.getPinnedFactRepo()?.forget(user)) ?? 0;
      } catch (error) {
        logger.error('Pinned facts could not be erased', { error, channel });
      }
    }

    let removedArchive = 0;
    let archivePartial = false;
    if (isDirectMessage && user && self.knowledgeErasure) {
      const report = await self.knowledgeErasure.forget({
        slackUserId: user,
        channelId: channel,
      });
      removedArchive = report.messages + report.facts;
      archivePartial = report.partial;
    }

    logger.info('Erasure request honoured — answered without any LLM call', {
      channel,
      isDirectMessage,
      removed,
      removedFacts,
      removedArchive,
      archivePartial,
    });
    await self.slack.chat.postMessage({
      channel,
      text: archivePartial
        ? ERASURE_FAILED_REPLY
        : erasureDoneReply(removed + removedFacts + removedArchive),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  } catch (error) {
    logger.error('Erasure request failed', { error, channel });
    await self.slack.chat.postMessage({
      channel,
      text: ERASURE_FAILED_REPLY,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  }
}

export async function runPinFact(
  self: SlackHandlerInternals,
  ctx: {
    text: string;
    channel: string;
    threadTs?: string;
    user?: string;
  },
): Promise<void> {
  const { text, channel, threadTs, user } = ctx;
  const factToPin = extractPinnedFact(text);
  if (!factToPin) return;
  const repo = user ? self.getPinnedFactRepo() : null;

  if (!repo) {
    logger.warn('Pin requested but no long-term memory is available', {
      channel,
      hasUser: Boolean(user),
    });
    await self.slack.chat.postMessage({
      channel,
      text: PIN_FAILED_REPLY,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    return;
  }

  try {
    await repo.pin(
      {
        id: crypto.randomUUID(),
        slackUserId: user!,
        fact: factToPin,
        createdAt: new Date(),
      },
      MAX_PINNED_FACTS,
    );

    logger.info('Fact pinned — answered without any LLM call', {
      channel,
      factLength: factToPin.length,
    });

    await self.slack.chat.postMessage({
      channel,
      text: pinnedFactReply(factToPin),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  } catch (error) {
    logger.error('Pin request failed', { error, channel });
    await self.slack.chat.postMessage({
      channel,
      text: PIN_FAILED_REPLY,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  }
}

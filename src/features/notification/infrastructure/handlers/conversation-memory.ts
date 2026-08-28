import { logger } from '../../../../shared/logger';
import type { ConversationTurn } from '../../../conversation/domain/entities/conversation-turn';
import { selectWindow } from '../../../conversation/domain/services/token-window';
import { DEFAULT_AGENT_ID } from '../../domain/services/agent-routing';
import {
  FOREIGN_TURN_PREFIX,
  buildContextPreamble,
  type RequesterIdentity,
} from '../../domain/services/context-preamble';
import { MAX_PINNED_FACTS } from '../../../../shared/pin-fact';
import type { SlackHandlerInternals } from './handler-internals';

export const CONVERSATION_QUERY_LIMIT = 40;

export const DEFAULT_PRUNE_PROBABILITY = 0.2;

export async function loadHistory(
  self: SlackHandlerInternals,
  conversationId: string,
): Promise<ConversationTurn[]> {
  const repo = self.getConversationRepo();
  if (!repo) return [];

  try {
    return await repo.findRecentTurns(conversationId, {
      ttlMs: self.conversationTtlMs,
      limit: CONVERSATION_QUERY_LIMIT,
    });
  } catch (error) {
    logger.warn('Unable to load conversation history — continuing without memory', {
      error,
      conversationId,
    });
    return [];
  }
}

export async function loadPinnedFacts(
  self: SlackHandlerInternals,
  slackUserId: string | undefined,
): Promise<readonly string[]> {
  if (!slackUserId) return [];

  const repo = self.getPinnedFactRepo();
  if (!repo) return [];

  try {
    const facts = await repo.list(slackUserId, MAX_PINNED_FACTS);
    return facts.map((entry) => entry.fact);
  } catch (error) {
    logger.error('Long-term memory unavailable — continuing without pinned facts', { error });
    return [];
  }
}

export async function rememberTurn(
  self: SlackHandlerInternals,
  turn: {
    conversationId: string;
    role: 'user' | 'assistant';
    content: string;
    agentId: string;
    slackUserId: string | null;
  },
): Promise<void> {
  const repo = self.getConversationRepo();
  if (!repo) return;

  try {
    await repo.append(turn);
  } catch (error) {
    logger.warn('Unable to persist a conversation turn', {
      error,
      conversationId: turn.conversationId,
      role: turn.role,
    });
  }
}

export async function sayAndRemember(
  self: SlackHandlerInternals,
  input: {
    channel: string;
    threadTs: string | undefined;
    conversationId: string;
    user: string | undefined;
    text?: string;
  },
  reply: string,
): Promise<void> {
  await self.slack.chat.postMessage({
    channel: input.channel,
    text: reply,
    ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
  });

  if (input.text !== undefined) {
    await rememberTurn(self, {
      conversationId: input.conversationId,
      role: 'user',
      content: input.text,
      agentId: DEFAULT_AGENT_ID,
      slackUserId: input.user ?? null,
    });
  }
  await rememberTurn(self, {
    conversationId: input.conversationId,
    role: 'assistant',
    content: reply,
    agentId: DEFAULT_AGENT_ID,
    slackUserId: null,
  });
}

export function buildMessages(
  self: SlackHandlerInternals,
  history: readonly ConversationTurn[],
  wrappedCurrentInput: string,
  context: {
    agentId: string;
    slackUserId?: string;
    identity: RequesterIdentity;
    pinnedFacts?: readonly string[];
  },
) {
  const window = selectWindow(history, self.conversationTokenBudget);

  const preamble = buildContextPreamble({
    slackUserId: context.slackUserId,
    displayName: context.identity.displayName,
    email: context.identity.email,
    employeeId: context.identity.employeeId,
    pinnedFacts: context.pinnedFacts,
    now: self.now(),
    hasForeignTurns: window.some(
      (turn) => turn.role === 'assistant' && turn.agentId !== context.agentId,
    ),
  });

  const replayed = window.map((turn) =>
    turn.role === 'assistant'
      ? ({
          role: 'assistant',
          content:
            turn.agentId === context.agentId ? turn.content : FOREIGN_TURN_PREFIX + turn.content,
        } as const)
      : ({ role: 'user', content: turn.content } as const),
  );

  const preambleMessages = preamble ? [{ role: 'system', content: preamble } as const] : [];

  return [
    ...preambleMessages,
    ...replayed,
    { role: 'user', content: wrappedCurrentInput } as const,
  ];
}

export function pruneIsDue(self: SlackHandlerInternals): boolean {
  if (self.pruneProbability <= 0) return false;
  if (self.pruneProbability >= 1) return true;
  // eslint-disable-next-line sonarjs/pseudo-random
  return Math.random() < self.pruneProbability;
}

export function schedulePruneIfDue(self: SlackHandlerInternals): void {
  if (!pruneIsDue(self)) return;

  const repo = self.getConversationRepo();
  if (!repo) return;

  void repo
    .pruneOlderThan(new Date(Date.now() - self.conversationTtlMs))
    .then((removed) => logger.info('Pruned expired conversation turns', { removed }))
    .catch((error) => logger.warn('Conversation prune failed', { error }));
}

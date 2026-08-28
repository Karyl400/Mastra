import { logger } from '../../../../shared/logger';
import type { SlackHandlerInternals } from './handler-internals';
import { auditAgentRun, describeAgentRun } from './agent-run-audit';
import { schedulePruneIfDue } from './conversation-memory';
import { scheduleDedupPruneIfDue } from './event-dedup';
import { scheduleRateLimitPruneIfDue } from './rate-limit-gate';

export function reportAgentTurn(
  self: SlackHandlerInternals,
  run: {
    user?: string;
    agentId: string;
    channel: string;
    conversationId: string;
    redacted: number;
    durationMs: number;
    steps: number | null;
    inputTokens: number | null;
    toolCalls: string[] | null;
    unsupportedClaim: string | null;
    deliveryPromise: string | null;
    truncated: boolean;
  },
): void {
  logger.info('Slack response sent', {
    channel: run.channel,
    agentId: run.agentId,
    conversationId: run.conversationId,
    redacted: run.redacted,
    durationMs: run.durationMs,
    steps: run.steps,
    inputTokens: run.inputTokens,
    toolCalls: run.toolCalls,
    unsupportedClaim: run.unsupportedClaim,
    deliveryPromise: run.deliveryPromise,
  });

  auditAgentRun(self, {
    user: run.user,
    agentId: run.agentId,
    ...describeAgentRun({
      toolCalls: run.toolCalls,
      durationMs: run.durationMs,
      steps: run.steps,
      inputTokens: run.inputTokens,
      unsupportedClaim: run.unsupportedClaim,
      deliveryPromise: run.deliveryPromise,
      truncated: run.truncated,
      redacted: run.redacted,
    }),
  });

  void self.getRateLimiter()?.consumeTokens(run.inputTokens);

  schedulePruneIfDue(self);
  scheduleDedupPruneIfDue(self);
  scheduleRateLimitPruneIfDue(self);
}

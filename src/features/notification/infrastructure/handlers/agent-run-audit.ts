import { AUDIT_ACTIONS } from '../../../../shared/audit-actions';
import { errorMessage, SecurityBlockError } from '../../../../shared/errors';
import { isActingTool } from '../../../../shared/agent-capabilities';
import type { SlackHandlerInternals } from './handler-internals';

export function describeAgentRun(run: {
  toolCalls: string[] | null;
  durationMs: number;
  steps: number | null;
  inputTokens: number | null;
  unsupportedClaim: string | null;
  deliveryPromise: string | null;
  truncated: boolean;
  redacted: number;
}): { status: 'success' | 'failure'; details: Record<string, unknown> } {
  const called = run.toolCalls;

  return {
    status: (run.unsupportedClaim ?? run.deliveryPromise) ? 'failure' : 'success',
    details: {
      toolCalls: called,
      actedOn: called === null ? null : called.filter(isActingTool),
      durationMs: run.durationMs,
      steps: run.steps,
      inputTokens: run.inputTokens,
      unsupportedClaim: run.unsupportedClaim,
      deliveryPromise: run.deliveryPromise,
      truncated: run.truncated,
      redacted: run.redacted,
    },
  };
}

export function auditAgentRun(
  self: SlackHandlerInternals,
  entry: {
    user?: string;
    agentId: string;
    status: 'success' | 'failure' | 'denied';
    errorMessage?: string;
    details: Record<string, unknown>;
  },
): void {
  void self.audit({
    action: AUDIT_ACTIONS.agentRun,
    actorId: entry.user ?? 'unknown',
    status: entry.status,
    resourceType: 'Agent',
    resourceId: entry.agentId,
    ...(entry.errorMessage ? { errorMessage: entry.errorMessage } : {}),
    details: entry.details,
  });
}

export function auditFailedRun(
  self: SlackHandlerInternals,
  run: {
    user?: string;
    agentId: string;
    error: unknown;
    phase: string;
    startedAt: number;
  },
): void {
  const blocked = run.error instanceof SecurityBlockError;

  auditAgentRun(self, {
    user: run.user,
    agentId: run.agentId,
    status: blocked ? 'denied' : 'failure',
    errorMessage: errorMessage(run.error),
    details: { phase: run.phase, durationMs: Date.now() - run.startedAt, blocked },
  });
}

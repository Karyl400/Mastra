import { logger } from '../shared/logger';

export const SLACK_ACK_BUDGET_MS = 3_000;

export const SLACK_ACK_AT_RISK_MS = 1_500;

export type AckBudgetState = 'ok' | 'at_risk' | 'exceeded';

export function classifyAckLatency(elapsedMs: number): AckBudgetState {
  if (elapsedMs >= SLACK_ACK_BUDGET_MS) {
    return 'exceeded';
  }
  if (elapsedMs >= SLACK_ACK_AT_RISK_MS) {
    return 'at_risk';
  }
  return 'ok';
}

export function reportAckBudget(state: AckBudgetState, details: Record<string, unknown>): void {
  if (state === 'exceeded') {
    logger.error('Slack ACK budget exceeded — Slack has already replayed this event', details);
  } else if (state === 'at_risk') {
    logger.warn('Slack ACK budget at risk', details);
  }
}

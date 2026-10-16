import { AGENT_GENERATE_TIMEOUT_MS, AGENT_MAX_STEPS } from './model-fallback';

export const FUNCTION_MAX_DURATION_MS = 60_000;

export const REPLY_MARGIN_MS = 5_000;

export const MIN_GENERATE_MS = 10_000;

export function runDeadline(startedAt: number): number {
  return startedAt + FUNCTION_MAX_DURATION_MS - REPLY_MARGIN_MS;
}

export function generateTimeoutMs(deadline: number, now: number): number {
  return Math.max(0, Math.min(AGENT_GENERATE_TIMEOUT_MS, deadline - now));
}

export function hasTimeForAnotherStep(deadline: number, now: number): boolean {
  return deadline - now >= MIN_GENERATE_MS;
}

export function agentCallBounds(
  deadline: number,
  now: number,
): { readonly maxSteps: number; readonly abortSignal: AbortSignal } {
  return {
    maxSteps: AGENT_MAX_STEPS,
    abortSignal: AbortSignal.timeout(generateTimeoutMs(deadline, now)),
  };
}

import { clearStepBlocked, writeStepBlocked } from './slack-request-context';

export type StepOutcome = 'served' | 'blocked';

export interface StepVerdict {
  readonly outcome: StepOutcome;
  readonly reason?: string;
}

export const STEP_OUTCOME_MARKER = Symbol.for('kisso.tool.stepOutcome');

const POSITIVE_FLAGS = ['found', 'saved', 'sent', 'stored', 'updated'] as const;

const REFUSING_STATUSES: ReadonlySet<string> = new Set(['refused', 'failed']);

const SERVED: StepVerdict = { outcome: 'served' };

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function classifyToolOutcome(result: unknown): StepVerdict {
  if (typeof result !== 'object' || result === null) return SERVED;

  const record = result as Record<string, unknown>;

  if (record.error === true) return { outcome: 'blocked', reason: 'invalid_call' };

  const reason = nonEmpty(record.reason);

  if (POSITIVE_FLAGS.some((flag) => record[flag] === true)) return SERVED;

  if (POSITIVE_FLAGS.some((flag) => record[flag] === false)) {
    return { outcome: 'blocked', reason: reason ?? 'refused' };
  }

  const status = nonEmpty(record.status);
  if (status && REFUSING_STATUSES.has(status)) {
    return { outcome: 'blocked', reason: reason ?? status };
  }

  if (reason) return { outcome: 'blocked', reason };

  return SERVED;
}

type ToolLike = { execute?: unknown };

function requestContextOf(args: readonly unknown[]): unknown {
  const context = args[1];
  if (typeof context !== 'object' || context === null) return undefined;
  return (context as { requestContext?: unknown }).requestContext;
}

function markOne(tool: unknown): void {
  if (typeof tool !== 'object' || tool === null) return;

  const branded = tool as Record<symbol, unknown> & ToolLike;
  if (branded[STEP_OUTCOME_MARKER] === true) return;

  const original = branded.execute;
  if (typeof original !== 'function') return;

  const run = original as (...args: unknown[]) => unknown;

  branded.execute = async (...args: unknown[]): Promise<unknown> => {
    const requestContext = requestContextOf(args);

    let result: unknown;
    try {
      result = await run(...args);
    } catch (error) {
      writeStepBlocked(requestContext, 'tool_error');
      throw error;
    }

    const verdict = classifyToolOutcome(result);
    if (verdict.outcome === 'blocked')
      writeStepBlocked(requestContext, verdict.reason ?? 'refused');
    else clearStepBlocked(requestContext);

    return result;
  };

  Object.defineProperty(branded, STEP_OUTCOME_MARKER, {
    value: true,
    enumerable: false,
    configurable: true,
  });
}

export function markStepOutcomes<T extends Record<string, unknown>>(tools: T): T {
  for (const tool of Object.values(tools)) markOne(tool);
  return tools;
}

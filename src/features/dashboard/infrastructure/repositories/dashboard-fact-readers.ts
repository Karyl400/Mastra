import { logger } from '../../../../shared/logger';

export async function readOrMark<T>(
  tables: readonly string[],
  unreadable: string[],
  run: () => Promise<T[]>,
): Promise<T[]> {
  try {
    return await run();
  } catch (error) {
    for (const table of tables) if (!unreadable.includes(table)) unreadable.push(table);
    logger.warn('Métrique indisponible — lecture impossible', { tables, error });
    return [];
  }
}

export function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function fingerprint(conversationId: string): string {
  let hash = 0;
  for (let i = 0; i < conversationId.length; i += 1) {
    hash = (hash * 31 + conversationId.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36).padStart(7, '0').slice(0, 7);
}

function parseDetails(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readToolNames(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((name): name is string => typeof name === 'string')
    : [];
}

export interface RunRow {
  status: string;
  error_message: string | null;
  details: string | null;
}

export function summariseRuns(rows: readonly RunRow[]): {
  agentRuns: number;
  agentRunsFailed: number;
  injectionsBlocked: number;
  requalifiedResponses: number;
  latenciesMs: readonly number[];
  toolCallCounts: Record<string, number>;
} {
  const latenciesMs: number[] = [];
  const toolCallCounts: Record<string, number> = {};
  let agentRunsFailed = 0;
  let injectionsBlocked = 0;
  let requalifiedResponses = 0;

  for (const row of rows) {
    if (row.status === 'failure') agentRunsFailed += 1;
    if (row.status === 'denied') injectionsBlocked += 1;

    const details = parseDetails(row.details);
    if (!details) continue;

    if (details.unsupportedClaim || details.deliveryPromise) requalifiedResponses += 1;

    const duration = Number(details.durationMs);
    if (Number.isFinite(duration) && duration >= 0) latenciesMs.push(duration);

    for (const name of readToolNames(details.toolCalls)) {
      toolCallCounts[name] = (toolCallCounts[name] ?? 0) + 1;
    }
  }

  return {
    agentRuns: rows.length,
    agentRunsFailed,
    injectionsBlocked,
    requalifiedResponses,
    latenciesMs,
    toolCallCounts,
  };
}

import { trace, context } from '@opentelemetry/api';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  traceId?: string;
  spanId?: string;
  requestId?: string;
  sessionId?: string;
  userId?: string;
  data: unknown;
  error?: {
    name: string;
    message: string;
    stack?: string;
    cause?: unknown;
  };
}

export interface LoggerOptions {
  level: LogLevel;
  baseContext: Record<string, unknown>;
  enabled: boolean;
  transport?: (entry: LogEntry) => void | Promise<void>;
  maxObjectDepth: number;
}

export interface ChildLogger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string | Error, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
  fatal(msg: string | Error, ...args: unknown[]): void;
  child(context: Record<string, unknown>): ChildLogger;
  getLevel(): LogLevel;
  setLevel(level: LogLevel): void;
}

export const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

export function getOtelContext(): { traceId?: string; spanId?: string } {
  try {
    const span = trace.getSpan(context.active());
    if (span) {
      const spanContext = span.spanContext();
      return {
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
      };
    }
  } catch {}
  return {};
}

import { randomUUID } from 'crypto';

import { maskPii } from './log-masking';
import { LOG_LEVELS, getOtelContext } from './log-entry';
import type { LogLevel, LogEntry, LoggerOptions, ChildLogger } from './log-entry';

export { maskPii, isPiiKey } from './log-masking';
export { PII_KEYS } from './log-pii-keys';
export type { LogLevel, LogEntry, LoggerOptions, ChildLogger } from './log-entry';

export class Logger implements ChildLogger {
  private level: LogLevel;
  private baseContext: Record<string, unknown>;
  private enabled: boolean;
  private transport?: (entry: LogEntry) => void | Promise<void>;
  private maxObjectDepth: number;
  private requestId: string;

  constructor(options: Partial<LoggerOptions> = {}) {
    this.level = (process.env.LOG_LEVEL as LogLevel) || options.level || 'info';
    this.baseContext = options.baseContext || {};
    this.enabled = options.enabled !== false;
    this.transport = options.transport;
    this.maxObjectDepth = options.maxObjectDepth || 10;
    this.requestId = (this.baseContext.requestId as string) || randomUUID();
  }

  info(msg: string, ...args: unknown[]): void {
    this.log('info', msg, args);
  }

  warn(msg: string, ...args: unknown[]): void {
    this.log('warn', msg, args);
  }

  error(msg: string | Error, ...args: unknown[]): void {
    if (msg instanceof Error) {
      this.log('error', msg.message, [msg, ...args]);
    } else {
      this.log('error', msg, args);
    }
  }

  debug(msg: string, ...args: unknown[]): void {
    this.log('debug', msg, args);
  }

  fatal(msg: string | Error, ...args: unknown[]): void {
    if (msg instanceof Error) {
      this.log('fatal', msg.message, [msg, ...args]);
    } else {
      this.log('fatal', msg, args);
    }
  }

  child(context: Record<string, unknown>): ChildLogger {
    const childLogger = new Logger({
      level: this.level,
      baseContext: { ...this.baseContext, ...context },
      enabled: this.enabled,
      transport: this.transport,
      maxObjectDepth: this.maxObjectDepth,
    });

    if (!context.requestId && this.requestId) {
      childLogger.requestId = this.requestId;
    }

    return childLogger;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private log(level: LogLevel, message: string, args: unknown[]): void {
    if (LOG_LEVELS[level] < LOG_LEVELS[this.level]) {
      return;
    }

    if (!this.enabled) {
      return;
    }

    try {
      const entry = this.buildLogEntry(level, message, args);
      this.writeLogEntry(level, entry);
    } catch (error) {
      console.error(`[LOGGER_ERROR] Failed to log message: ${message}`, error);
    }
  }

  private buildLogEntry(level: LogLevel, message: string, args: unknown[]): LogEntry {
    const { traceId, spanId } = getOtelContext();

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      traceId,
      spanId,
      requestId: this.requestId,
      data: [],
    };

    if (Object.keys(this.baseContext).length > 0) {
      Object.assign(entry, this.baseContext);
    }

    if (args.length === 1 && args[0] instanceof Error) {
      entry.error = {
        name: args[0].name,
        message: args[0].message,
        stack: args[0].stack,
        cause: args[0].cause
          ? maskPii(args[0].cause, { maxDepth: this.maxObjectDepth })
          : undefined,
      };
    } else if (args.length > 0) {
      const maskedArgs = args.map((arg) => maskPii(arg, { maxDepth: this.maxObjectDepth }));

      if (maskedArgs.length === 1) {
        entry.data = maskedArgs[0];
      } else {
        entry.data = maskedArgs;
      }
    }

    return entry;
  }

  private writeLogEntry(level: LogLevel, entry: LogEntry): void {
    const jsonString = this.safeStringify(entry);

    switch (level) {
      case 'debug':
        console.debug(jsonString);
        break;
      case 'info':
        console.log(jsonString);
        break;
      case 'warn':
        console.warn(jsonString);
        break;
      case 'error':
      case 'fatal':
        console.error(jsonString);
        break;
    }

    if (this.transport) {
      setImmediate(() => {
        this.transport?.(entry)?.catch((err) => {
          console.error('[LOGGER_TRANSPORT_ERROR]', err);
        });
      });
    }

    if (level === 'fatal') {
      console.error('[FATAL] Application will terminate');
    }
  }

  private safeStringify(obj: unknown): string {
    try {
      return JSON.stringify(obj);
    } catch {
      return JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        message: '[SERIALIZATION_ERROR] Failed to stringify log entry',
        error: 'Circular reference or non-serializable object',
      });
    }
  }
}

export const logger: ChildLogger = new Logger({
  level: (process.env.LOG_LEVEL as LogLevel) || 'info',
  baseContext: {
    service: process.env.SERVICE_NAME || 'unknown',
    environment: process.env.NODE_ENV || 'development',
    version: process.env.APP_VERSION || '0.0.0',
  },
});

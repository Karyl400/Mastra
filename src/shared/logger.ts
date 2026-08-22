import { trace, context } from '@opentelemetry/api';
import { randomUUID } from 'crypto';

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

interface LogEntry {
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

interface LoggerOptions {
  level: LogLevel;
  baseContext: Record<string, unknown>;
  enabled: boolean;
  transport?: (entry: LogEntry) => void | Promise<void>;
  maxObjectDepth: number;
}

interface ChildLogger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string | Error, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
  fatal(msg: string | Error, ...args: unknown[]): void;
  child(context: Record<string, unknown>): ChildLogger;
  getLevel(): LogLevel;
  setLevel(level: LogLevel): void;
}

const PII_KEYS = new Set([
  'email',
  'mail',
  'e-mail',
  'firstname',
  'lastname',
  'fullname',
  'name',
  'surname',
  'phone',
  'telephone',
  'mobile',
  'cell',
  'fax',
  'ssn',
  'socialsecurity',
  'social_security',
  'nin',
  'nationalid',
  'passport',
  'driverlicense',
  'driving_license',
  'birthdate',
  'dateofbirth',
  'birth_date',
  'dob',
  'address',
  'street',
  'city',
  'zipcode',
  'postalcode',
  'postal_code',
  'country',
  'state',
  'region',
  'ip',
  'ipaddress',
  'ip_address',
  'mac',
  'macaddress',

  'password',
  'passwd',
  'pwd',
  'secret',
  'passcode',
  'pin',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'apikey',
  'api_key',
  'apisecret',
  'api_secret',
  'privatekey',
  'private_key',
  'publickey',
  'public_key',
  'certificate',
  'cert',
  'authorization',
  'auth',
  'bearer',
  'cookie',
  'session',
  'sessionid',
  'session_id',
  'jwt',
  'otp',
  'mfa',
  'tfa',
  'twofactor',

  'creditcard',
  'credit_card',
  'cardnumber',
  'card_number',
  'cvv',
  'cvc',
  'cvv2',
  'cid',
  'iban',
  'bic',
  'swift',
  'accountnumber',
  'account_number',
  'bankaccount',

  'medicalrecord',
  'medical_record',
  'healthrecord',
  'patientid',
  'patient_id',
  'diagnosis',
  'prescription',
  'insurance',
  'insurancenumber',

  'fingerprint',
  'retina',
  'facial',
  'biometric',
  'dna',
  'genetic',

  'passportnumber',
  'passport_number',
  'documentid',
  'document_id',
  'taxid',
  'tax_id',
  'vat',

  'text',
  'content',
  'body',
  'subject',
  'fact',
  'dailywork',
  'daily_work',
  'workstyle',
  'work_style',
]);

const PII_VALUE_PATTERNS = [
  { pattern: /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, mask: '***@***.***' },
  { pattern: /^eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}$/, mask: '***JWT***' },
  { pattern: /^(?:sk|pk|rk)-[a-zA-Z0-9]{20,}$/, mask: '***API_KEY***' },
  {
    pattern: /^\d{13,19}$/,
    mask: '****-****-****-****',
    validator: (v: string) => v.replace(/\s/g, '').length >= 13,
  },
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

const MAX_LOGGED_KEYS = 50;

function maskPlainObject(
  obj: Record<string, unknown>,
  ctx: { depth: number; maxDepth: number; seen: WeakSet<object>; keyPath: string[] },
): Record<string, unknown> {
  const { depth, maxDepth, keyPath } = ctx;
  const masked: Record<string, unknown> = {};

  const entries = Object.entries(obj);
  const isLargeObject = entries.length > MAX_LOGGED_KEYS;
  const sampledEntries = isLargeObject ? entries.slice(0, MAX_LOGGED_KEYS) : entries;

  for (const [key, value] of sampledEntries) {
    const newKeyPath = [...keyPath, key];

    if (isPiiKey(key)) {
      masked[key] = '[REDACTED:' + getPiiCategory(key) + ']';
      continue;
    }

    if (typeof value === 'string' && isPiiValue(value)) {
      masked[key] = maskPiiValue(value);
      continue;
    }

    masked[key] = maskPii(value, {
      depth: depth + 1,
      maxDepth,
      seen: new WeakSet<object>(),
      keyPath: newKeyPath,
    });
  }

  if (isLargeObject && sampledEntries.length < entries.length) {
    masked['_truncation_note'] =
      `Object had ${entries.length} keys, the first ${sampledEntries.length} were logged`;
  }

  return masked;
}

const NOT_SPECIAL = Symbol('not-a-special-type');

function maskSpecialType(
  obj: object,
  ctx: { depth: number; maxDepth: number; seen: WeakSet<object>; keyPath: string[] },
): unknown {
  const { depth, maxDepth, seen, keyPath } = ctx;

  if (obj instanceof Date) return obj.toISOString();
  if (obj instanceof RegExp) return obj.toString();
  if (obj instanceof Error) {
    return {
      name: obj.name,
      message: maskPrimitiveValue(obj.message, [...keyPath, 'message']),
      stack: obj.stack ? '[STACK_TRACE]' : undefined,
      cause: obj.cause
        ? maskPii(obj.cause, { depth: depth + 1, maxDepth, seen, keyPath: [...keyPath, 'cause'] })
        : undefined,
    };
  }
  if (Buffer.isBuffer(obj)) return '[BUFFER:' + obj.length + 'bytes]';
  if (obj instanceof Map) return '[MAP:' + obj.size + 'entries]';
  if (obj instanceof Set) return '[SET:' + obj.size + 'entries]';
  if (typeof obj === 'function') return '[FUNCTION:' + (obj.name || 'anonymous') + ']';

  return NOT_SPECIAL;
}

function maskPii(
  obj: unknown,
  options: {
    depth?: number;
    maxDepth?: number;
    seen?: WeakSet<object>;
    keyPath?: string[];
  } = {},
): unknown {
  const { depth = 0, maxDepth = 10, seen = new WeakSet<object>(), keyPath = [] } = options;

  if (depth > maxDepth) {
    return '[MAX_DEPTH_EXCEEDED]';
  }

  if (typeof obj !== 'object' || obj === null) {
    return maskPrimitiveValue(obj, keyPath);
  }

  if (seen.has(obj as object)) {
    return '[CIRCULAR_REFERENCE]';
  }

  const special = maskSpecialType(obj, { depth, maxDepth, seen, keyPath });
  if (special !== NOT_SPECIAL) return special;

  if (Array.isArray(obj)) {
    seen.add(obj as object);
    return obj.map((item, index) =>
      maskPii(item, {
        depth: depth + 1,
        maxDepth,
        seen: new WeakSet<object>(),
        keyPath: [...keyPath, String(index)],
      }),
    );
  }

  if (isPlainObject(obj)) {
    seen.add(obj as object);
    return maskPlainObject(obj, { depth, maxDepth, seen, keyPath });
  }

  return '[UNKNOWN_TYPE:' + typeof obj + ']';
}

function maskPrimitiveValue(value: unknown, _keyPath: string[]): unknown {
  if (typeof value === 'string' && isPiiValue(value)) {
    return maskPiiValue(value);
  }
  return value;
}

function isPiiKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, '');
  return PII_KEYS.has(normalized);
}

function getPiiCategory(key: string): string {
  const normalized = key.toLowerCase().replace(/[_-]/g, '');
  if (['email', 'mail', 'e-mail'].includes(normalized)) return 'EMAIL';
  if (['password', 'passwd', 'pwd', 'secret'].includes(normalized)) return 'CREDENTIAL';
  if (['token', 'accesstoken', 'refreshtoken'].includes(normalized)) return 'TOKEN';
  if (['creditcard', 'cardnumber', 'cvv', 'iban'].includes(normalized)) return 'PCI';
  if (['ssn', 'socialsecurity', 'passport'].includes(normalized)) return 'PII';
  return 'SENSITIVE';
}

function isPiiValue(value: string): boolean {
  for (const { pattern, validator } of PII_VALUE_PATTERNS) {
    if (pattern.test(value)) {
      if (validator) {
        return validator(value);
      }
      return true;
    }
  }
  return false;
}

function maskPiiValue(value: string): string {
  for (const { pattern, mask } of PII_VALUE_PATTERNS) {
    if (pattern.test(value)) {
      return mask;
    }
  }
  return '[REDACTED]';
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

function getOtelContext(): { traceId?: string; spanId?: string } {
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

class Logger implements ChildLogger {
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

export {
  Logger,
  maskPii,
  isPiiKey,
  PII_KEYS,
  type LogLevel,
  type LogEntry,
  type LoggerOptions,
  type ChildLogger,
};

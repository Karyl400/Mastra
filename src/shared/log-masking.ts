import { PII_KEYS, PII_VALUE_PATTERNS } from './log-pii-keys';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
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

  if (obj instanceof Date) {
    return obj.toISOString();
  }
  if (obj instanceof RegExp) {
    return obj.toString();
  }
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
  if (Buffer.isBuffer(obj)) {
    return '[BUFFER:' + obj.length + 'bytes]';
  }
  if (obj instanceof Map) {
    return '[MAP:' + obj.size + 'entries]';
  }
  if (obj instanceof Set) {
    return '[SET:' + obj.size + 'entries]';
  }
  if (typeof obj === 'function') {
    return '[FUNCTION:' + (obj.name || 'anonymous') + ']';
  }

  return NOT_SPECIAL;
}

export function maskPii(
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
  if (special !== NOT_SPECIAL) {
    return special;
  }

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

export function isPiiKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, '');
  return PII_KEYS.has(normalized);
}

function getPiiCategory(key: string): string {
  const normalized = key.toLowerCase().replace(/[_-]/g, '');
  if (['email', 'mail', 'e-mail'].includes(normalized)) {
    return 'EMAIL';
  }
  if (['password', 'passwd', 'pwd', 'secret'].includes(normalized)) {
    return 'CREDENTIAL';
  }
  if (['token', 'accesstoken', 'refreshtoken'].includes(normalized)) {
    return 'TOKEN';
  }
  if (['creditcard', 'cardnumber', 'cvv', 'iban'].includes(normalized)) {
    return 'PCI';
  }
  if (['ssn', 'socialsecurity', 'passport'].includes(normalized)) {
    return 'PII';
  }
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

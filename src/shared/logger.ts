const isDebug = process.env.LOG_LEVEL === 'debug';

function maskPii(obj: unknown): unknown {
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(maskPii);

  const masked = { ...obj } as Record<string, unknown>;
  for (const [key, value] of Object.entries(masked)) {
    if (key.toLowerCase() === 'email' && typeof value === 'string') {
      masked[key] = '***@***.***';
    } else if (typeof value === 'object' && value !== null) {
      masked[key] = maskPii(value);
    }
  }
  return masked;
}

function formatLog(level: string, msg: string, args: unknown[]) {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    message: msg,
    data: args.map(maskPii),
  };
  return JSON.stringify(payload);
}

export const logger = {
  info: (msg: string, ...args: unknown[]) => {
    console.log(formatLog('INFO', msg, args));
  },
  warn: (msg: string, ...args: unknown[]) => {
    console.warn(formatLog('WARN', msg, args));
  },
  error: (msg: string, ...args: unknown[]) => {
    console.error(formatLog('ERROR', msg, args));
  },
  debug: (msg: string, ...args: unknown[]) => {
    if (isDebug) {
      console.debug(formatLog('DEBUG', msg, args));
    }
  },
};

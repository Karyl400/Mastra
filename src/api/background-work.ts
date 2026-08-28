const VERCEL_REQUEST_CONTEXT = Symbol.for('@vercel/request-context');

interface VercelRequestContext {
  waitUntil?: (promise: Promise<unknown>) => void;
}

type VercelRequestContextHolder = {
  [VERCEL_REQUEST_CONTEXT]?: { get?: () => VercelRequestContext | undefined };
};

export type BackgroundMechanism = 'vercel-wait-until' | 'detached';

export function getVercelWaitUntil(): ((promise: Promise<unknown>) => void) | undefined {
  const holder = globalThis as typeof globalThis & VercelRequestContextHolder;
  const context = holder[VERCEL_REQUEST_CONTEXT]?.get?.();
  return typeof context?.waitUntil === 'function' ? context.waitUntil.bind(context) : undefined;
}

export function scheduleBackgroundWork(work: Promise<unknown>): BackgroundMechanism {
  const waitUntil = getVercelWaitUntil();
  if (waitUntil) {
    waitUntil(work);
    return 'vercel-wait-until';
  }
  return 'detached';
}

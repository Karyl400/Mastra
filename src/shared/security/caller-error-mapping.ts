const CALLER_ERROR_PREFIXES = [
  'Invalid input data:',
  'Invalid initial data:',
  'Invalid request context:',
] as const;

export const CALLER_ERROR_STATUS = 400;

export interface HttpErrorLike {
  status?: number;
  message?: string;
}

export function isCallerError(error: HttpErrorLike | undefined | null): boolean {
  if (!error || error.status !== 500) return false;

  const message = typeof error.message === 'string' ? error.message.trimStart() : '';
  if (!message) return false;

  return CALLER_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix));
}

export function isCallerErrorBody(status: number, body: string): boolean {
  if (status !== 500) return false;

  let message: string;
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    message = typeof parsed.error === 'string' ? parsed.error : String(parsed.message ?? '');
  } catch {
    message = body;
  }

  return isCallerError({ status, message });
}

interface MiddlewareContext {
  res?: Response;
}

export function createCallerErrorMiddleware(options: { onRemap?: (message: string) => void } = {}) {
  return async (c: unknown, next: () => Promise<void>): Promise<Response | void> => {
    try {
      await next();
    } catch (error) {
      const httpError = error as HttpErrorLike & { getResponse?: () => Response };
      if (!isCallerError(httpError)) throw error;

      options.onRemap?.(String(httpError.message));

      const original =
        typeof httpError.getResponse === 'function' ? httpError.getResponse() : undefined;
      const body = original
        ? await original.clone().text()
        : JSON.stringify({ error: httpError.message });

      return new Response(body, {
        status: CALLER_ERROR_STATUS,
        headers: original?.headers ?? { 'content-type': 'application/json' },
      });
    }

    const ctx = c as MiddlewareContext;
    const res = ctx?.res;
    if (!res || res.status !== 500) return;

    const body = await res.clone().text();
    if (!isCallerErrorBody(res.status, body)) return;

    options.onRemap?.(body);

    ctx.res = new Response(body, {
      status: CALLER_ERROR_STATUS,
      headers: res.headers,
    });
  };
}

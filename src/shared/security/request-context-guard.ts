import { CALLER_ERROR_STATUS } from './caller-error-mapping';

export const FORGEABLE_CONTEXT_PREFIX = 'slack';

interface GuardedRequest {
  req?: { raw?: Request };
}

export function createRequestContextGuard(options: { onReject?: (keys: string[]) => void }) {
  return async (c: unknown, next: () => Promise<void>): Promise<Response | void> => {
    const forged = await readForgedKeys((c as GuardedRequest)?.req?.raw);

    if (forged.length === 0) {
      await next();
      return;
    }

    options.onReject?.(forged);

    return new Response(
      JSON.stringify({
        error:
          'requestContext must not carry server-issued keys: ' +
          forged.join(', ') +
          '. These are set by the Slack events route and cannot be supplied by a caller.',
      }),
      { status: CALLER_ERROR_STATUS, headers: { 'content-type': 'application/json' } },
    );
  };
}

async function readForgedKeys(raw: Request | undefined): Promise<string[]> {
  if (!raw || raw.method === 'GET' || raw.method === 'HEAD') return [];

  let body: unknown;
  try {
    body = await raw.clone().json();
  } catch {
    return [];
  }

  const context = (body as { requestContext?: unknown } | null)?.requestContext;
  if (!context || typeof context !== 'object' || Array.isArray(context)) return [];

  return Object.keys(context).filter((key) =>
    key.toLowerCase().startsWith(FORGEABLE_CONTEXT_PREFIX),
  );
}

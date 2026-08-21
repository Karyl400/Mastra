const FORBIDDEN = 403;

export function isToolExecutionPath(rawPath: string): boolean {
  const segments = (rawPath.split('?')[0] ?? '')
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase());

  const last = segments.length - 1;
  if (segments.length < 4) return false;
  if (segments[0] !== 'api') return false;
  if (segments[last] !== 'execute') return false;
  if (segments[last - 2] !== 'tools') return false;

  if (segments.length === 4) return true;
  return segments.length === 6 && segments[1] === 'agents';
}

interface GuardedContext {
  req?: { path?: string; raw?: Request };
}

function pathOf(c: unknown): string {
  const req = (c as GuardedContext)?.req;
  if (typeof req?.path === 'string') return req.path;
  const url = req?.raw?.url;
  if (typeof url === 'string') {
    try {
      return new URL(url).pathname;
    } catch {
      return '';
    }
  }
  return '';
}

export function createToolExecutionGuard(options: { onReject?: (path: string) => void }) {
  return async (c: unknown, next: () => Promise<void>): Promise<Response | void> => {
    const path = pathOf(c);

    if (!isToolExecutionPath(path)) {
      await next();
      return;
    }

    options.onReject?.(path);

    return new Response(
      JSON.stringify({
        error:
          'Executing a tool over HTTP is disabled. Tools carry no requester identity on this ' +
          'path, so the authorisation boundary cannot be applied. Use Slack, which is the only ' +
          'legitimate producer of the request context these tools rely on.',
      }),
      { status: FORBIDDEN, headers: { 'content-type': 'application/json' } },
    );
  };
}

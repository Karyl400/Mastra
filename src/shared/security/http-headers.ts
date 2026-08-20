interface ResponseCarrier {
  res: Response;
}

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};

export function createSecurityHeadersMiddleware() {
  return async (context: unknown, next: () => Promise<void>): Promise<void> => {
    await next();

    const c = context as ResponseCarrier;
    if (!c?.res) return;

    const headers = new Headers(c.res.headers);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);

    c.res = new Response(c.res.body, {
      status: c.res.status,
      statusText: c.res.statusText,
      headers,
    });
  };
}

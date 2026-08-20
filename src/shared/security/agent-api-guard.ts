import { CALLER_ERROR_STATUS } from './caller-error-mapping';
import { containsInternalMarkers } from './agent-output';
import { detectInjectionAttempts } from './llm-guardrail';

export const INSTRUCTIONS_REDACTED = '[instructions non divulguées]';

const LEAKED_RESPONSE_REPLACEMENT =
  'Réponse retirée : elle exposait la configuration interne de l’agent.';

const PROMPT_FIELDS = new Set(['instructions']);

const AGENT_TEXT_FIELDS = new Set(['text']);

const MAX_DEPTH = 6;

interface GuardedContext {
  req?: { raw?: Request };
  res?: Response;
}

export function createAgentApiGuard(options: {
  onRefused?: (types: string[]) => void;
  onRedacted?: (what: string) => void;
}) {
  return async (c: unknown, next: () => Promise<void>): Promise<Response | void> => {
    const ctx = c as GuardedContext;
    const raw = ctx?.req?.raw;

    if (!raw || !isAgentsPath(raw)) {
      await next();
      return;
    }

    const attempts = await detectInjectionInBody(raw);
    if (attempts.length > 0) {
      options.onRefused?.(attempts);
      return new Response(
        JSON.stringify({
          error: 'This request was refused: it attempts to extract or override agent instructions.',
        }),
        { status: CALLER_ERROR_STATUS, headers: { 'content-type': 'application/json' } },
      );
    }

    await next();

    const redacted = await redactResponse(ctx.res, options.onRedacted);
    if (redacted) ctx.res = redacted;
  };
}

function isAgentsPath(raw: Request): boolean {
  try {
    return new URL(raw.url).pathname.startsWith('/api/agents');
  } catch {
    return false;
  }
}

async function detectInjectionInBody(raw: Request): Promise<string[]> {
  if (raw.method === 'GET' || raw.method === 'HEAD') return [];

  let body: unknown;
  try {
    body = await raw.clone().json();
  } catch {
    return [];
  }

  const messages = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(messages)) return [];

  const found = new Set<string>();
  for (const message of messages) {
    const content = (message as { content?: unknown })?.content;
    let text = '';
    if (typeof message === 'string') text = message;
    else if (typeof content === 'string') text = content;
    if (!text) continue;
    for (const type of detectInjectionAttempts(text)) found.add(type);
  }
  return [...found];
}

async function redactResponse(
  res: Response | undefined,
  onRedacted?: (what: string) => void,
): Promise<Response | undefined> {
  if (!res) return undefined;

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(await res.clone().text());
  } catch {
    return undefined;
  }

  const found: string[] = [];
  const cleaned = redactValue(parsed, 0, found);
  if (found.length === 0) return undefined;

  onRedacted?.(found.join(','));
  return new Response(JSON.stringify(cleaned), { status: res.status, headers: res.headers });
}

function redactValue(value: unknown, depth: number, found: string[]): unknown {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1, found));

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (PROMPT_FIELDS.has(key) && typeof child === 'string' && child.length > 0) {
      found.push(key);
      out[key] = INSTRUCTIONS_REDACTED;
      continue;
    }

    if (AGENT_TEXT_FIELDS.has(key) && typeof child === 'string') {
      const markers = containsInternalMarkers(child);
      if (markers.length > 0) {
        found.push(`${key}:${markers.join('+')}`);
        out[key] = LEAKED_RESPONSE_REPLACEMENT;
        continue;
      }
    }

    out[key] = redactValue(child, depth + 1, found);
  }
  return out;
}

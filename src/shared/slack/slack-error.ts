const MAX_CAUSE_DEPTH = 8;

const SLACK_API_ERROR_RE = /An API error occurred:\s*([a-z0-9_]+)/i;
const BARE_CODE_RE = /^[a-z][a-z0-9_]*$/;

function causeChain(error: unknown): unknown[] {
  const seen = new Set<unknown>();
  const nodes: unknown[] = [];

  let current: unknown = error;
  for (
    let depth = 0;
    current !== null && current !== undefined && depth < MAX_CAUSE_DEPTH;
    depth++
  ) {
    if (typeof current === 'object' || typeof current === 'function') {
      if (seen.has(current)) break;
      seen.add(current);
    }
    nodes.push(current);
    current = (current as { cause?: unknown }).cause;
  }

  return nodes;
}

function messageOf(node: unknown): string {
  if (node instanceof Error) return node.message;
  if (typeof node === 'string') return node;
  return '';
}

function codeFromData(node: unknown): string | undefined {
  if (typeof node !== 'object' || node === null) return undefined;
  const data = (node as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return undefined;
  const code = (data as { error?: unknown }).error;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

function codeFromMessage(node: unknown): string | undefined {
  const message = messageOf(node);
  if (message.length === 0) return undefined;

  const tagged = SLACK_API_ERROR_RE.exec(message);
  if (tagged?.[1]) return tagged[1];

  const trimmed = message.trim();
  return BARE_CODE_RE.test(trimmed) ? trimmed : undefined;
}

export function slackErrorCode(error: unknown): string | undefined {
  const nodes = causeChain(error);

  for (const node of nodes) {
    const code = codeFromData(node);
    if (code) return code;
  }

  for (const node of nodes) {
    const code = codeFromMessage(node);
    if (code) return code;
  }

  return undefined;
}

export function slackErrorMentions(error: unknown, code: string): boolean {
  if (slackErrorCode(error) === code) return true;
  return causeChain(error).some((node) => messageOf(node).includes(code));
}

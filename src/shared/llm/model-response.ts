export const MODEL_TRUNCATED_NOTICE =
  '_(Ma réponse a été coupée avant la fin : redemande-moi la suite si elle te manque.)_';

export interface ModelResponseShape {
  readonly truncated: boolean;
  readonly empty: boolean;
}

const TRUNCATED_REASONS = new Set(['length', 'max_tokens', 'maxtokens', 'max-tokens']);

function normalizeReason(raw: unknown): string {
  return typeof raw === 'string'
    ? raw
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, '_')
    : '';
}

export function describeModelResponse(response: unknown): ModelResponseShape {
  if (typeof response !== 'object' || response === null) return { truncated: false, empty: true };

  const candidate = response as { text?: unknown; finishReason?: unknown };
  const text = typeof candidate.text === 'string' ? candidate.text : '';
  const reason = normalizeReason(candidate.finishReason);

  return {
    truncated: TRUNCATED_REASONS.has(reason) || TRUNCATED_REASONS.has(reason.replace(/_/g, '')),
    empty: text.trim().length === 0,
  };
}

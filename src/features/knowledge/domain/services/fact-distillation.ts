import { signalScore } from './excerpt-salience';

export type FactKind = 'decision' | 'engagement' | 'blocage' | 'echeance' | 'question';

export interface DistilledFact {
  readonly kind: FactKind;
  readonly summary: string;
  readonly score: number;
}

export const KNOWLEDGE_FACT_MIN_SCORE = 3;

export const FACT_SUMMARY_MAX_CHARS = 180;

const KIND_TESTS: ReadonlyArray<{ readonly kind: FactKind; readonly test: RegExp }> = [
  {
    kind: 'decision',
    test: /(?<!\p{L})(?:on part sur|on a décidé|on décide|c'est acté|c’est acté|c'est validé|c’est validé|validé|go pour|on retient|décision)(?!\p{L})/iu,
  },
  {
    kind: 'blocage',
    test: /(?<!\p{L})(?:bloqué|bloquant|problème|panne|urgent|cassé|down|incident|erreur)(?!\p{L})/iu,
  },
  {
    kind: 'engagement',
    test: /(?<!\p{L})(?:je m'en occupe|je m’en occupe|je prends|je m'en charge|je m’en charge|je fais|je gère|c'est moi qui|c’est moi qui)(?!\p{L})/iu,
  },
  {
    kind: 'echeance',
    test: /(?<!\p{L})(?:avant le|d'ici|d’ici|deadline|échéance|au plus tard|lundi|mardi|mercredi|jeudi|vendredi)(?!\p{L})/iu,
  },
  { kind: 'question', test: /\?\s*$/u },
];

export const FACT_KIND_LABELS: Readonly<Record<FactKind, string>> = {
  decision: 'Décision',
  engagement: 'Engagement',
  blocage: 'Blocage',
  echeance: 'Échéance',
  question: 'Question ouverte',
};

function flatten(raw: string): string {
  return (
    raw
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function truncateOnBoundary(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;

  const window = value.slice(0, maxChars);
  const lastSpace = window.lastIndexOf(' ');
  const cut = lastSpace > maxChars * 0.6 ? window.slice(0, lastSpace) : window;

  return `${cut.trimEnd().replace(/[,;:.–—-]$/u, '')}…`;
}

export function classifyFact(text: string): FactKind | null {
  const raw = flatten(text);
  for (const candidate of KIND_TESTS) {
    if (candidate.test.test(raw)) return candidate.kind;
  }
  return null;
}

export function distillFact(text: string): DistilledFact | null {
  const raw = flatten(text);
  if (raw.length === 0) return null;

  const score = signalScore(raw);
  if (score < KNOWLEDGE_FACT_MIN_SCORE) return null;

  const kind = classifyFact(raw);
  if (!kind) return null;

  return { kind, summary: truncateOnBoundary(raw, FACT_SUMMARY_MAX_CHARS), score };
}

import { signalScore } from './excerpt-salience';

export type FactKind = 'decision' | 'engagement' | 'blocage' | 'echeance' | 'question';

export interface DistilledFact {
  readonly kind: FactKind;
  readonly summary: string;
  readonly score: number;
}

export const KNOWLEDGE_FACT_MIN_SCORE = 3;

export const FACT_SUMMARY_MAX_CHARS = 180;

/**
 * ⚠️ **LES MOTIFS SONT ÉCRITS SANS ACCENT, ET LE TEXTE EST PLIÉ AVANT D'ÊTRE TESTÉ.**
 *
 * Trouvé en production le 2026-08-21, par une sonde qui cherchait tout autre chose : le message
 * « on a **decide** de partir sur postgres » a bien été archivé au niveau 1 et n'a produit
 * AUCUN fait au niveau 2. Le motif exigeait `décidé` ; l'accent manquait.
 *
 * Ce n'est pas un cas de laboratoire : sur un clavier de téléphone, dans la précipitation, en
 * copie d'un outil qui les mange, une bonne part du français réel s'écrit sans accents. Un
 * classifieur qui échoue en silence sur cette moitié-là est pire qu'absent — il donne
 * l'illusion d'une couverture.
 *
 * Troisième forme du même piège dans ce dépôt, après `\b` en ASCII sur `bloqué` et
 * `matchesKeyword` : **le français accentué casse tout ce qui compare des caractères.** On
 * plie (`NFD` + retrait des marques) des DEUX côtés, une fois pour toutes.
 *
 * ⚠️ L'apostrophe typographique est pliée par la même passe (`’` → `'`) — c'est le cas le plus
 * fréquent sur mobile, et il a déjà coûté un refus non reconnu dans `shared/confirmation.ts`.
 */
function foldForMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[’´`]/g, "'");
}

const KIND_TESTS: ReadonlyArray<{ readonly kind: FactKind; readonly test: RegExp }> = [
  {
    kind: 'decision',
    test: /(?<!\p{L})(?:on part sur|on a decide|on decide|c'est acte|c'est valide|valide|go pour|on retient|decision)(?!\p{L})/iu,
  },
  {
    kind: 'blocage',
    test: /(?<!\p{L})(?:bloque|bloquant|probleme|panne|urgent|casse|down|incident|erreur)(?!\p{L})/iu,
  },
  {
    kind: 'engagement',
    test: /(?<!\p{L})(?:je m'en occupe|je prends|je m'en charge|je fais|je gere|c'est moi qui)(?!\p{L})/iu,
  },
  {
    kind: 'echeance',
    test: /(?<!\p{L})(?:avant le|d'ici|deadline|echeance|au plus tard|lundi|mardi|mercredi|jeudi|vendredi)(?!\p{L})/iu,
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
  // ⚠️ On teste le texte PLIÉ, on rend le texte d'origine ailleurs : le résumé stocké garde ses
  // accents, seule la comparaison les ignore.
  const folded = foldForMatch(flatten(text));
  for (const candidate of KIND_TESTS) {
    if (candidate.test.test(folded)) return candidate.kind;
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

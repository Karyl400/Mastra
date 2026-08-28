/* eslint-disable sonarjs/regex-complexity, security/detect-unsafe-regex */

import { injectionCounter } from './guardrail-metrics';
import { normalizeForDetection } from './homoglyph-folding';

const INJECTION_PATTERNS: ReadonlyArray<{ regex: RegExp; type: string }> = [
  {
    regex: /<\/?\s*(?:user_input|external_data|system|instruction)/i,
    type: 'XML tag injection',
  },
  { regex: /\[system\]|\[assistant\]|<\|.*?\|>/i, type: 'Special token injection' },
  {
    regex: /base64\s*(?:decode|encode)?|rot13|fromCharCode|atob|btoa/i,
    type: 'Encoding request',
  },

  {
    regex: /(?:ignore|disregard|forget)\s+(?:the\s+)?(?:above|previous|all)/i,
    type: 'Instruction override',
  },
  { regex: /you\s+are\s+(?:now|no\s+longer)/i, type: 'Role redefinition' },
  { regex: /\b(?:DAN|developer\s*mode|god\s*mode)\b/i, type: 'Jailbreak keyword' },

  {
    regex:
      /(?<!\b(?:ai|as|a|avons|avez|ont|avais|avait|pas|jamais|deja|bien|toujours)\s)\b(?:ignore[sz]?|ignorer|oublie[sz]?|oublier|efface[rz]?|annule[rz]?)\b[^\n,;:.!?]{0,16}\b(?:instruction|consigne|directive|regle|ce\s+qui\s+preced|(?:ci|au)-dessus|contexte)/i,
    type: 'Instruction override (FR)',
  },
  { regex: /\b(?:fais|faites|faire)\s+abstraction\b/i, type: 'Instruction override (FR)' },
  {
    regex:
      /\b(?:met(?:s|tez|tre|tons)?\s{1,3}de\s{1,3}cote|laiss(?:e|es|ez|er|ons)\s{1,3}tomber|fai(?:s|t|tes|re)\s{1,3}fi|pass(?:e|es|ez|er|ons)\s{1,3}outre|ecart(?:e|es|ez|er|ons))\b[^\n,;:.!?]{0,16}\b(?:instruction|consigne|directive|regle|ce\s{1,3}qui\s{1,3}preced|(?:ci|au)-dessus|contexte)/i,
    type: 'Instruction override (FR)',
  },
  { regex: /\bne\s+(?:tiens|tenez|tenir)\s+pas\s+compte\b/i, type: 'Instruction override (FR)' },

  {
    regex: /\b(?:tu\s+es|t'es|vous\s+etes)\s+(?:desormais|maintenant|dorenavant)\b/i,
    type: 'Role redefinition (FR)',
  },
  {
    regex: /\bdesormais,?\s+(?:tu|vous)\s+(?:es|etes|seras|serez)\b/i,
    type: 'Role redefinition (FR)',
  },
  { regex: /\b(?:tu\s+n|vous\s+n)'(?:es|etes)\s+plus\b/i, type: 'Role redefinition (FR)' },
  {
    regex: /\b(?:comporte|conduis)[-\s]toi\s+comme\b|\b(?:agis|agissez)\s+comme\s+si\b/i,
    type: 'Role redefinition (FR)',
  },
  { regex: /\bjoue\s+le\s+role\b|\bfais\s+semblant\s+d/i, type: 'Role redefinition (FR)' },
  {
    regex:
      /\b(?:imagine|imaginons|imaginez|suppose|supposons|supposez)\s+(?:que\s+)?(?:tu\s+es|t'es|vous\s+etes)\b/i,
    type: 'Role redefinition (FR)',
  },

  {
    regex: /\b(?:prompt|invite|message|configuration)\s+(?:systeme|initiale?|d'origine|interne)\b/i,
    type: 'System prompt extraction (FR)',
  },
  {
    regex:
      /\b(?:tes|ton|ta|vos|votre)\s+(?:instruction|consigne|directive|regle)s?\s+(?:systeme|initiale|interne|secrete|cachee)/i,
    type: 'System prompt extraction (FR)',
  },
  {
    regex:
      /\b(?:affiche|montre|recopie|reproduis)[a-z]{0,3}\b[^\n]{0,16}\b(?:ton|tes|votre|vos)\s+(?:prompt|instruction|consigne|directive|regle)/i,
    type: 'System prompt extraction (FR)',
  },
  {
    regex:
      /\b(?:revel|divulgu|repet)[a-z]{0,3}\b[^\n]{0,16}\b(?:ton|tes|votre|vos)\s+(?:prompt|instruction|consigne|directive|regle)/i,
    type: 'System prompt extraction (FR)',
  },

  {
    regex: /\bmode\s+(?:developpeur|debogage|debug|libre|non\s+restreint|sans\s+filtre)\b/i,
    type: 'Jailbreak keyword (FR)',
  },
  {
    regex: /\bsans\s+(?:aucune\s|)(?:restriction|limitation|limite|filtre|censure|garde-fou)/i,
    type: 'Jailbreak keyword (FR)',
  },
];

export function detectInjectionAttempts(text: string): string[] {
  const attempts = new Set<string>();

  const normalized = normalizeForDetection(text);

  for (const { regex, type } of INJECTION_PATTERNS) {
    if (regex.test(normalized)) {
      attempts.add(type);
      injectionCounter.add(1, { type });
    }
  }

  return [...attempts];
}

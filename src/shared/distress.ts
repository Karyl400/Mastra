import { normalizeIntentText } from './intent-text';
import {
  SELF_HARM_PHRASES_FR,
  AGGRESSION_PHRASES_FR,
  SELF_HARM_PHRASES_EN,
  SELF_HARM_NOUNS_EN,
  AGGRESSION_NOUNS_EN,
  AGGRESSION_PHRASES_EN,
  SELF_HARM_PHRASES_SHARED,
  SELF_HARM_NOUNS_SHARED,
  AGGRESSION_PHRASES_SHARED,
  AGGRESSION_NOUNS_SHARED,
  AGGRESSION_NOUNS_FR,
} from './distress-phrases';
import { FRENCH_MARKERS, ENGLISH_MARKERS } from './distress-language-markers';
import {
  DISTRESS_REPLY,
  DISTRESS_REPLY_EN,
  AGGRESSION_REPLY,
  AGGRESSION_REPLY_EN,
} from './distress-replies';

export {
  DISTRESS_REPLY,
  DISTRESS_REPLY_EN,
  AGGRESSION_REPLY,
  AGGRESSION_REPLY_EN,
} from './distress-replies';

export type DistressKind = 'self_harm' | 'aggression';

const APOSTROPHES = /['‘’ʼ´`]/g;

const MAX_DISTRESS_LENGTH = 2000;

function probeWindow(raw: string): string {
  if (raw.length <= MAX_DISTRESS_LENGTH) {
    return raw;
  }
  const half = Math.floor(MAX_DISTRESS_LENGTH / 2);
  return `${raw.slice(0, half)} ${raw.slice(-half)}`;
}

export type DistressLanguage = 'fr' | 'en' | 'both';

function normalizedForms(raw: string): readonly string[] {
  const spaced = normalizeIntentText(raw);
  const joined = normalizeIntentText(raw.replace(APOSTROPHES, ''));
  return spaced === joined ? [spaced] : [spaced, joined];
}

const FIRST_PERSON_MARKERS: ReadonlySet<string> = new Set([
  'je',
  'j',
  'me',
  'm',
  'moi',
  'mon',
  'ma',
  'mes',
  'i',
  'im',
  'my',
  'myself',
  'mine',
]);

function speaksOfSelf(forms: readonly string[]): boolean {
  return forms.some((form) => form.split(' ').some((token) => FIRST_PERSON_MARKERS.has(token)));
}

const BARE_NOUN_MAX_TOKENS = 3;

function isBareStatement(forms: readonly string[]): boolean {
  const spaced = forms[0] ?? '';
  return spaced.split(' ').filter(Boolean).length <= BARE_NOUN_MAX_TOKENS;
}

function matchesNoun(forms: readonly string[], nouns: readonly string[]): boolean {
  if (!matchesAny(forms, nouns)) {
    return false;
  }
  return speaksOfSelf(forms) || isBareStatement(forms);
}

function matchesAny(forms: readonly string[], phrases: readonly string[]): boolean {
  return phrases.some((phrase) => forms.some((form) => form.includes(phrase)));
}

function countMarkers(tokens: readonly string[], markers: ReadonlySet<string>): number {
  let count = 0;
  for (const token of tokens) {
    if (markers.has(token)) {
      count += 1;
    }
  }
  return count;
}

function guessLanguage(forms: readonly string[]): DistressLanguage {
  const tokens = forms[0].split(' ');
  const french = countMarkers(tokens, FRENCH_MARKERS);
  const english = countMarkers(tokens, ENGLISH_MARKERS);

  if (french > english) {
    return 'fr';
  }
  if (english > french) {
    return 'en';
  }
  return 'both';
}

const ENDING_IT_DESIRE = /(?:veux|voudrais|aimerais|envie d|souhaite|pense a) en finir(?!\p{L})/u;

const ENDING_IT_LIFE_COMPLEMENT =
  /en finir avec (?:la |ma |cette |tout |toute )?(?:vie|tout|ca)(?!\p{L})/u;

const ENDING_IT_HAS_COMPLEMENT = /en finir avec(?!\p{L})/u;

function wantsToEndTheirLife(forms: readonly string[]): boolean {
  return forms.some((form) => {
    if (!ENDING_IT_DESIRE.test(form)) {
      return false;
    }
    if (!ENDING_IT_HAS_COMPLEMENT.test(form)) {
      return true;
    }
    return ENDING_IT_LIFE_COMPLEMENT.test(form);
  });
}

export function distressKind(text: string | undefined | null): DistressKind | null {
  const raw = (text ?? '').trim();
  if (raw.length === 0) {
    return null;
  }

  const forms = normalizedForms(probeWindow(raw));

  if (
    matchesAny(forms, SELF_HARM_PHRASES_FR) ||
    matchesAny(forms, SELF_HARM_PHRASES_EN) ||
    matchesAny(forms, SELF_HARM_PHRASES_SHARED) ||
    matchesNoun(forms, SELF_HARM_NOUNS_SHARED) ||
    matchesNoun(forms, SELF_HARM_NOUNS_EN) ||
    wantsToEndTheirLife(forms)
  ) {
    return 'self_harm';
  }

  if (
    matchesAny(forms, AGGRESSION_PHRASES_FR) ||
    matchesAny(forms, AGGRESSION_PHRASES_EN) ||
    matchesAny(forms, AGGRESSION_PHRASES_SHARED) ||
    matchesNoun(forms, AGGRESSION_NOUNS_FR) ||
    matchesNoun(forms, AGGRESSION_NOUNS_EN) ||
    matchesNoun(forms, AGGRESSION_NOUNS_SHARED)
  ) {
    return 'aggression';
  }

  return null;
}

export function distressLanguage(text: string | undefined | null): DistressLanguage | null {
  const raw = (text ?? '').trim();
  if (raw.length === 0) {
    return null;
  }

  const forms = normalizedForms(probeWindow(raw));

  const french =
    matchesAny(forms, SELF_HARM_PHRASES_FR) ||
    matchesAny(forms, AGGRESSION_PHRASES_FR) ||
    matchesNoun(forms, AGGRESSION_NOUNS_FR) ||
    wantsToEndTheirLife(forms);
  const english =
    matchesAny(forms, SELF_HARM_PHRASES_EN) ||
    matchesAny(forms, AGGRESSION_PHRASES_EN) ||
    matchesNoun(forms, SELF_HARM_NOUNS_EN) ||
    matchesNoun(forms, AGGRESSION_NOUNS_EN);

  if (french && english) {
    return 'both';
  }
  if (french) {
    return 'fr';
  }
  if (english) {
    return 'en';
  }

  const shared =
    matchesNoun(forms, SELF_HARM_NOUNS_SHARED) || matchesNoun(forms, AGGRESSION_NOUNS_SHARED);
  if (!shared) {
    return null;
  }

  return guessLanguage(forms);
}

export function detectsDistress(text: string | undefined | null): boolean {
  return distressLanguage(text) !== null;
}

export function distressReplyFor(text: string | undefined | null): string {
  const language = distressLanguage(text);
  if (language === null) {
    return DISTRESS_REPLY;
  }

  const kind = distressKind(text) ?? 'self_harm';
  const fr = kind === 'aggression' ? AGGRESSION_REPLY : DISTRESS_REPLY;
  const en = kind === 'aggression' ? AGGRESSION_REPLY_EN : DISTRESS_REPLY_EN;

  if (language === 'en') {
    return en;
  }
  if (language === 'both') {
    return `${fr}\n\n${en}`;
  }
  return fr;
}

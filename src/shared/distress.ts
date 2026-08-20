import { normalizeIntentText } from './intent-text';

const DISTRESS_PHRASES_FR: readonly string[] = [
  'je veux mourir',
  'je veux meurir',
  'envie de mourir',
  'envie d en finir',
  'en finir avec la vie',
  'me suicider',
  'me faire du mal',
  'idees noires',
  'plus envie de vivre',
  'a quoi bon vivre',

  'je ne vais pas bien',
  'je vais tres mal',
  'je vais pas bien',
  'je craque',
  'je suis a bout',
  'je suis deprime',

  'harcele',
  'harcelement',
  'harcelement moral',
  'harcelement sexuel',
  'je suis agresse',
  'agression sexuelle',
  'me menace',
  'me harcele',
  'je suis discrimine',
];

const DISTRESS_PHRASES_EN: readonly string[] = [
  'i want to die',
  'i wanna die',
  'want to be dead',
  'better off dead',
  'kill myself',
  'killing myself',
  'end my life',
  'take my own life',
  'want to end it',
  'end it all',
  'suicidal',
  'self harm',
  'hurting myself',
  'hurt myself',
  'harm myself',
  'no reason to live',
  'nothing to live for',
  'dont want to live',
  'do not want to live',
  'dont want to be here anymore',
  'do not want to be here anymore',
  'want to disappear',
  'whats the point anymore',
  'no point in living',

  'im not doing well',
  'i am not doing well',
  'i cant go on',
  'cant go on anymore',
  'cant go on like this',
  'cant take it anymore',
  'cant do this anymore',
  'cant cope',
  'breaking point',
  'having a breakdown',
  'nervous breakdown',
  'feel hopeless',
  'feeling hopeless',
  'am hopeless',
  'feel worthless',
  'feeling worthless',
  'am worthless',
  'burned out',
  'burnt out',
  'burning out',
  'im depressed',
  'i am depressed',
  'falling apart',

  'harassment',
  'harassing me',
  'being harassed',
  'was harassed',
  'sexually harassed',
  'bullying me',
  'being bullied',
  'was bullied',
  'threatening me',
  'threatens me',
  'threatened me',
  'assaulted me',
  'was assaulted',
  'sexual assault',
  'discriminated against',
];

const DISTRESS_PHRASES_SHARED: readonly string[] = [
  'suicide',
  'depression',
  'burn out',
  'burnout',
  'discrimination',
];

const FRENCH_MARKERS: ReadonlySet<string> = new Set([
  'je',
  'tu',
  'ne',
  'pas',
  'ni',
  'suis',
  'mon',
  'ma',
  'mes',
  'moi',
  'tres',
  'avec',
  'pour',
  'que',
  'qui',
  'des',
  'les',
  'une',
  'ce',
  'cette',
  'du',
  'dans',
  'depuis',
  'tout',
  'rien',
  'vais',
  'veux',
  'peux',
  'fais',
  'sais',
  'crois',
  'envie',
  'jamais',
  'trop',
  'est',
  'et',
  'mais',
  'parce',
]);

const ENGLISH_MARKERS: ReadonlySet<string> = new Set([
  'i',
  'im',
  'my',
  'myself',
  'the',
  'to',
  'and',
  'is',
  'am',
  'are',
  'be',
  'been',
  'do',
  'dont',
  'cant',
  'wont',
  'anymore',
  'feel',
  'feeling',
  'this',
  'that',
  'it',
  'of',
  'with',
  'for',
  'you',
  'have',
  'has',
  'had',
  'was',
  'were',
  'not',
  'so',
  'really',
  'very',
  'going',
  'want',
  'need',
  'think',
  'about',
]);

const APOSTROPHES = /['‘’ʼ´`]/g;

const MAX_DISTRESS_LENGTH = 2000;

export type DistressLanguage = 'fr' | 'en' | 'both';

function normalizedForms(raw: string): readonly string[] {
  const spaced = normalizeIntentText(raw);
  const joined = normalizeIntentText(raw.replace(APOSTROPHES, ''));
  return spaced === joined ? [spaced] : [spaced, joined];
}

function matchesAny(forms: readonly string[], phrases: readonly string[]): boolean {
  return phrases.some((phrase) => forms.some((form) => form.includes(phrase)));
}

function countMarkers(tokens: readonly string[], markers: ReadonlySet<string>): number {
  let count = 0;
  for (const token of tokens) {
    if (markers.has(token)) count += 1;
  }
  return count;
}

function guessLanguage(forms: readonly string[]): DistressLanguage {
  const tokens = forms[0].split(' ');
  const french = countMarkers(tokens, FRENCH_MARKERS);
  const english = countMarkers(tokens, ENGLISH_MARKERS);

  if (french > english) return 'fr';
  if (english > french) return 'en';
  return 'both';
}

export function distressLanguage(text: string | undefined | null): DistressLanguage | null {
  const raw = (text ?? '').trim();
  if (raw.length === 0 || raw.length > MAX_DISTRESS_LENGTH) return null;

  const forms = normalizedForms(raw);

  const french = matchesAny(forms, DISTRESS_PHRASES_FR);
  const english = matchesAny(forms, DISTRESS_PHRASES_EN);

  if (french && english) return 'both';
  if (french) return 'fr';
  if (english) return 'en';

  if (!matchesAny(forms, DISTRESS_PHRASES_SHARED)) return null;

  return guessLanguage(forms);
}

export function detectsDistress(text: string | undefined | null): boolean {
  return distressLanguage(text) !== null;
}

export const DISTRESS_REPLY =
  "Je suis un outil d'onboarding, je ne suis pas la bonne personne pour ça — mais je ne vais " +
  'pas te laisser sans réponse.\n\n' +
  "Si c'est urgent : *0800 0787 746* (SURPIN, gratuit, 24h/24, partout au Nigeria), ou le " +
  '*112* si la vie de quelqu’un est en jeu maintenant.\n' +
  'Pour une situation au travail — harcèlement, conflit, souffrance — tu peux en parler à ' +
  "l'équipe RH de Kisso, ou à quelqu'un en qui tu as confiance dans le workspace.\n\n" +
  "Je n'ai pas transmis ce message : il reste entre nous.";

export const DISTRESS_REPLY_EN =
  "I'm an onboarding tool, I'm not the right person for this — but I won't leave you without " +
  'an answer.\n\n' +
  "If it's urgent: *0800 0787 746* (SURPIN, free, 24/7, anywhere in Nigeria), or *112* if " +
  'someone’s life is at risk right now.\n' +
  'For something at work — harassment, conflict, distress — you can talk to Kisso’s HR team, ' +
  'or to someone you trust in the workspace.\n\n' +
  "I haven't passed this message on: it stays between us.";

export function distressReplyFor(text: string | undefined | null): string {
  const language = distressLanguage(text);
  if (language === 'en') return DISTRESS_REPLY_EN;
  if (language === 'both') return `${DISTRESS_REPLY}\n\n${DISTRESS_REPLY_EN}`;
  return DISTRESS_REPLY;
}

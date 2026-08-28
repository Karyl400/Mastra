import { normalizeIntentText } from './intent-text';
import { ESCALATION_CONTACT, ESCALATION_CONTACT_EN } from './escalation';
import { EMERGENCY_LINES } from './emergency-lines';

export type DistressKind = 'self_harm' | 'aggression';

const SELF_HARM_PHRASES_FR: readonly string[] = [
  'je veux mourir',
  'je veux meurir',
  'envie de mourir',
  'je n en peux plus',
  'j en peux plus',
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
];

const AGGRESSION_PHRASES_FR: readonly string[] = [
  'je suis agresse',
  'j ai ete agresse',
  'ete agressee',
  'me menace',
  'me harcele',
  'je suis discrimine',

  'me suis fait agresser',
  'on m a agresse',
  'je suis en danger',
  'me frappe',
  'ma frappe',
  'me touche sans mon consentement',
];

const SELF_HARM_PHRASES_EN: readonly string[] = [
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
  'having a breakdown',
  'nervous breakdown',
  'feel hopeless',
  'feeling hopeless',
  'am hopeless',
  'feel worthless',
  'feeling worthless',
  'am worthless',
  'im depressed',
  'i am depressed',
];

const SELF_HARM_NOUNS_EN: readonly string[] = [
  'breaking point',
  'falling apart',
  'burned out',
  'burnt out',
  'burning out',
];

const AGGRESSION_NOUNS_EN: readonly string[] = [
  'harassment',
  'death threat',
  'death threats',
  'sexual assault',
];

const AGGRESSION_PHRASES_EN: readonly string[] = [
  'harassing me',
  'harasses me',
  'harass me',
  'being harassed',
  'was harassed',
  'sexually harassed',
  'sexually assaulted',
  'bullying me',
  'being bullied',
  'was bullied',
  'threatening me',
  'threatens me',
  'threatened me',
  'assaulted me',
  'was assaulted',
  'discriminated against',

  'i am in danger',
  'im in danger',
  'he hit me',
  'she hit me',
  'they hit me',
  'touched me without',
];

const SELF_HARM_PHRASES_SHARED: readonly string[] = [];

const SELF_HARM_NOUNS_SHARED: readonly string[] = ['suicide', 'depression', 'burn out', 'burnout'];

const AGGRESSION_PHRASES_SHARED: readonly string[] = [];

const AGGRESSION_NOUNS_SHARED: readonly string[] = ['discrimination'];

const AGGRESSION_NOUNS_FR: readonly string[] = [
  'harcele',
  'harcelement',
  'harcelement moral',
  'harcelement sexuel',
  'agression sexuelle',
  'intimidation',
  'menace de mort',
  'menaces de mort',
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

function probeWindow(raw: string): string {
  if (raw.length <= MAX_DISTRESS_LENGTH) return raw;
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
  if (!matchesAny(forms, nouns)) return false;
  return speaksOfSelf(forms) || isBareStatement(forms);
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

const ENDING_IT_DESIRE = /(?:veux|voudrais|aimerais|envie d|souhaite|pense a) en finir(?!\p{L})/u;

const ENDING_IT_LIFE_COMPLEMENT =
  /en finir avec (?:la |ma |cette |tout |toute )?(?:vie|tout|ca)(?!\p{L})/u;

const ENDING_IT_HAS_COMPLEMENT = /en finir avec(?!\p{L})/u;

function wantsToEndTheirLife(forms: readonly string[]): boolean {
  return forms.some((form) => {
    if (!ENDING_IT_DESIRE.test(form)) return false;
    if (!ENDING_IT_HAS_COMPLEMENT.test(form)) return true;
    return ENDING_IT_LIFE_COMPLEMENT.test(form);
  });
}

export function distressKind(text: string | undefined | null): DistressKind | null {
  const raw = (text ?? '').trim();
  if (raw.length === 0) return null;

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
  if (raw.length === 0) return null;

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

  if (french && english) return 'both';
  if (french) return 'fr';
  if (english) return 'en';

  const shared =
    matchesNoun(forms, SELF_HARM_NOUNS_SHARED) || matchesNoun(forms, AGGRESSION_NOUNS_SHARED);
  if (!shared) return null;

  return guessLanguage(forms);
}

export function detectsDistress(text: string | undefined | null): boolean {
  return distressLanguage(text) !== null;
}

const CRISIS = EMERGENCY_LINES.crisis;
const MEDICAL = EMERGENCY_LINES.medical;

export const DISTRESS_REPLY =
  "Merci de me l'avoir dit. Je ne suis pas la bonne personne pour t'aider là-dessus, et je ne " +
  'vais pas te laisser sans réponse.\n\n' +
  `Si c'est urgent : *${CRISIS.number}* (${CRISIS.label}), ou le *${MEDICAL.number}* ` +
  `(${MEDICAL.label}) si la vie de quelqu'un est en jeu maintenant.\n` +
  `Et si tu préfères en parler à quelqu'un d'ici : ${ESCALATION_CONTACT}, ou quelqu'un en qui ` +
  'tu as confiance dans le workspace.\n\n' +
  "Je n'ai transmis ce message à personne : il reste entre nous.";

export const DISTRESS_REPLY_EN =
  "Thank you for telling me. I'm not the right person to help you with this, and I won't leave " +
  'you without an answer.\n\n' +
  `If it's urgent: *${CRISIS.number}* (${CRISIS.labelEn}), or *${MEDICAL.number}* ` +
  `(${MEDICAL.labelEn}) if someone's life is at risk right now.\n` +
  `And if you'd rather talk to someone here: ${ESCALATION_CONTACT_EN}, or anyone you trust in ` +
  'the workspace.\n\n' +
  "I haven't passed this message on to anyone: it stays between us.";

export const AGGRESSION_REPLY =
  "Ce que tu me décris n'a rien de normal, et tu as bien fait de le dire.\n\n" +
  `Si tu es en danger tout de suite : *${CRISIS.number}* (${CRISIS.label}). Le ` +
  `*${MEDICAL.number}* (${MEDICAL.label}) pour une urgence médicale.\n` +
  `Pour ce qui se passe au travail — harcèlement, menaces, discrimination — parles-en à ` +
  `${ESCALATION_CONTACT}. C'est lui qui peut agir là-dessus, pas moi.\n\n` +
  "Je n'ai transmis ce message à personne : il reste entre nous.";

export const AGGRESSION_REPLY_EN =
  "What you're describing is not normal, and you were right to say it.\n\n" +
  `If you're in danger right now: *${CRISIS.number}* (${CRISIS.labelEn}). ` +
  `*${MEDICAL.number}* (${MEDICAL.labelEn}) for a medical emergency.\n` +
  `For what's happening at work — harassment, threats, discrimination — talk to ` +
  `${ESCALATION_CONTACT_EN}. He's the one who can act on it, not me.\n\n` +
  "I haven't passed this message on to anyone: it stays between us.";

export function distressReplyFor(text: string | undefined | null): string {
  const language = distressLanguage(text);
  if (language === null) return DISTRESS_REPLY;

  const kind = distressKind(text) ?? 'self_harm';
  const fr = kind === 'aggression' ? AGGRESSION_REPLY : DISTRESS_REPLY;
  const en = kind === 'aggression' ? AGGRESSION_REPLY_EN : DISTRESS_REPLY_EN;

  if (language === 'en') return en;
  if (language === 'both') return `${fr}\n\n${en}`;
  return fr;
}

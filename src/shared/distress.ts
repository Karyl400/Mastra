import { normalizeIntentText } from './intent-text';
import { ESCALATION_CONTACT, ESCALATION_CONTACT_EN } from './escalation';
import { EMERGENCY_LINES } from './emergency-lines';

/**
 * ⚠️ DEUX SITUATIONS, DEUX RÉPONSES — séparées le 2026-08-21.
 *
 * Ce module n'en connaissait qu'une. « je suis harcelé par mon manager » et « je veux
 * mourir » recevaient le MÊME texte, qui citait une ligne de prévention du suicide. À
 * quelqu'un qui vient de dire qu'on l'agresse, ce texte répond à côté : il lui donne un
 * numéro d'écoute là où il lui faut la police, et il ne nomme personne qui puisse AGIR sur
 * ce qui se passe au travail.
 *
 * L'inverse est vrai aussi : envoyer vers la police quelqu'un qui pense à en finir, c'est
 * répondre par une procédure à une souffrance.
 *
 * ⚠️ EN CAS DE DOUTE, C'EST `self_harm` QUI L'EMPORTE. Un message peut porter les deux
 * (« je suis harcelé et je n'en peux plus, je veux en finir ») et les deux erreurs ne se
 * valent pas : traiter une agression comme une détresse donne quand même un numéro
 * d'urgence joignable, l'inverse remplace une aide vitale par une démarche administrative.
 */
export type DistressKind = 'self_harm' | 'aggression';

const SELF_HARM_PHRASES_FR: readonly string[] = [
  'je veux mourir',
  'je veux meurir',
  'envie de mourir',
  'envie d en finir',
  'en finir avec la vie',
  // ⚠️ « je veux en finir » n'était détecté par RIEN jusqu'au 2026-08-21 — ni ici, ni par
  // « envie d en finir », ni par « en finir avec la vie ». C'est pourtant la formulation la
  // plus courante en français, et le faux négatif le plus cher que ce module puisse avoir.
  // Trouvé par un test qui cherchait tout autre chose : la priorité détresse/agression.
  'veux en finir',
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
  'harcele',
  'harcelement',
  'harcelement moral',
  'harcelement sexuel',
  'je suis agresse',
  'agression sexuelle',
  'me menace',
  'me harcele',
  'je suis discrimine',

  // Ajoutées le 2026-08-21 avec la séparation. Chacune décrit un FAIT subi, jamais une
  // opinion : c'est le critère qui a fait écarter « violence » et « conflit » nus, trop
  // courants pour désigner une situation vécue.
  'me suis fait agresser',
  'on m a agresse',
  'je suis en danger',
  'menace de mort',
  'menaces de mort',
  'me frappe',
  'ma frappe',
  'intimidation',
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
];

const AGGRESSION_PHRASES_EN: readonly string[] = [
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

  'i am in danger',
  'im in danger',
  'death threat',
  'death threats',
  'he hit me',
  'she hit me',
  'they hit me',
  'touched me without',
];

const SELF_HARM_PHRASES_SHARED: readonly string[] = [
  'suicide',
  'depression',
  'burn out',
  'burnout',
];

const AGGRESSION_PHRASES_SHARED: readonly string[] = ['discrimination'];

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

/**
 * La NATURE de la situation, indépendamment de la langue.
 *
 * ⚠️ `self_harm` gagne quand les deux correspondent — voir l'en-tête du module.
 */
export function distressKind(text: string | undefined | null): DistressKind | null {
  const raw = (text ?? '').trim();
  if (raw.length === 0 || raw.length > MAX_DISTRESS_LENGTH) return null;

  const forms = normalizedForms(raw);

  if (
    matchesAny(forms, SELF_HARM_PHRASES_FR) ||
    matchesAny(forms, SELF_HARM_PHRASES_EN) ||
    matchesAny(forms, SELF_HARM_PHRASES_SHARED)
  ) {
    return 'self_harm';
  }

  if (
    matchesAny(forms, AGGRESSION_PHRASES_FR) ||
    matchesAny(forms, AGGRESSION_PHRASES_EN) ||
    matchesAny(forms, AGGRESSION_PHRASES_SHARED)
  ) {
    return 'aggression';
  }

  return null;
}

export function distressLanguage(text: string | undefined | null): DistressLanguage | null {
  const raw = (text ?? '').trim();
  if (raw.length === 0 || raw.length > MAX_DISTRESS_LENGTH) return null;

  const forms = normalizedForms(raw);

  const french =
    matchesAny(forms, SELF_HARM_PHRASES_FR) || matchesAny(forms, AGGRESSION_PHRASES_FR);
  const english =
    matchesAny(forms, SELF_HARM_PHRASES_EN) || matchesAny(forms, AGGRESSION_PHRASES_EN);

  if (french && english) return 'both';
  if (french) return 'fr';
  if (english) return 'en';

  const shared =
    matchesAny(forms, SELF_HARM_PHRASES_SHARED) || matchesAny(forms, AGGRESSION_PHRASES_SHARED);
  if (!shared) return null;

  return guessLanguage(forms);
}

export function detectsDistress(text: string | undefined | null): boolean {
  return distressLanguage(text) !== null;
}

const CRISIS = EMERGENCY_LINES.crisis;
const MEDICAL = EMERGENCY_LINES.medical;

/**
 * ⚠️ CES QUATRE TEXTES SONT LES SEULS DU DÉPÔT QUI N'ONT AUCUNE VARIANTE, et un test le
 * verrouille. Ailleurs, la répétition littérale est ce qui fait « machine » et on la combat.
 * Ici, elle est une garantie : ce texte a été pesé mot à mot, et un tirage qui en changerait
 * la formulation ferait qu'on ne saurait plus lequel a été lu.
 *
 * ⚠️ MARCEL NE JOUE PAS L'EMPATHIE ICI. C'est le seul endroit où « presque humain » serait
 * nuisible : simuler la compassion auprès de quelqu'un de vulnérable, c'est lui mentir au pire
 * moment. Le texte reconnaît, oriente vers quelqu'un qui peut agir, et s'efface. Ce qui a
 * changé le 2026-08-21 est seulement l'auto-désignation « je suis un outil d'onboarding », qui
 * ouvrait le message par une phrase sur SOI — remplacée par une phrase sur la personne.
 */
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

/**
 * ⚠️ LA RÉPONSE À UNE AGRESSION NOMME QUELQU'UN QUI PEUT AGIR — c'est ce qui la distingue.
 *
 * Une ligne d'écoute ne peut rien contre un collègue qui menace : elle écoute. Ce qu'il faut
 * ici, c'est la police si le danger est immédiat, et la personne qui a autorité sur le
 * workspace pour ce qui s'y passe. Le message le dit explicitement — « c'est lui qui peut
 * faire quelque chose, pas moi » — parce que laisser croire le contraire, c'est exactement le
 * genre de promesse creuse que ce dépôt traque partout ailleurs.
 */
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

import { normalizeIntentText } from './intent-text';
import { isNegatedNear } from './negation';

const EDIT_VERB_STEMS: readonly string[] = [
  'complet',
  'rempli',
  'renseign',
  'corrig',
  'modifi',
  'mets',
  'mettre',
  'actualis',
  'update',
];

const SEND_VERB_STEMS: readonly string[] = [
  'renvoi',
  'renvoy',
  'redonn',
  'envoi',
  'envoy',
  'ouvr',
  'donne',
];

const PROFILE_OBJECTS: readonly string[] = [
  'mon profil',
  'mes informations',
  'mes infos',
  'ma fiche',
  'mon dossier',
  'mes coordonnees',
  'mes donnees personnelles',
  'my profile',
];

const FORM_OBJECTS: readonly string[] = [
  'formulaire de profil',
  'formulaire du profil',
  'le formulaire',
  'profile form',
];

const REQUEST_MARKERS: readonly string[] = [
  'peux tu',
  'tu peux',
  'pourrais tu',
  'tu pourrais',
  'merci de',
  'je veux',
  'je voudrais',
  'j aimerais',
  'je dois',
  'je peux',
  'comment',
  'ou est',
  'ou je',
  'please',
];

const REQUEST_LOOKBACK_WORDS = 6;

const NEGATIONS: ReadonlySet<string> = new Set([
  'ne',
  'n',
  'pas',
  'sans',
  'jamais',
  'aucun',
  'aucune',
  'rien',
  'never',
  'dont',
]);

const MOTIVE_MARKERS: readonly string[] = ['pourquoi', 'why'];

const MAX_REQUEST_LENGTH = 200;

function isARequest(words: readonly string[], verbIndex: number): boolean {
  if (verbIndex === 0) return true;

  const before = words.slice(Math.max(0, verbIndex - REQUEST_LOOKBACK_WORDS), verbIndex).join(' ');
  return REQUEST_MARKERS.some((marker) => before.includes(marker));
}

function startsWithAny(word: string, stems: readonly string[]): boolean {
  return stems.some((stem) => word.startsWith(stem));
}

export function requestsProfileForm(text: string | undefined | null): boolean {
  const raw = (text ?? '').trim();
  if (raw.length === 0 || raw.length > MAX_REQUEST_LENGTH) return false;

  const normalized = normalizeIntentText(raw);

  const aboutMyProfile = PROFILE_OBJECTS.some((object) => normalized.includes(object));
  const aboutTheForm = FORM_OBJECTS.some((object) => normalized.includes(object));
  if (!aboutMyProfile && !aboutTheForm) return false;

  if (MOTIVE_MARKERS.some((marker) => normalized.includes(marker))) return false;

  const words = normalized.split(' ');

  return words.some((word, index) => {
    const isEdit = aboutMyProfile && startsWithAny(word, EDIT_VERB_STEMS);
    const isSend = aboutTheForm && startsWithAny(word, SEND_VERB_STEMS);
    if (!isEdit && !isSend) return false;

    return isARequest(words, index) && !isNegatedNear(words, index, NEGATIONS);
  });
}

export const PROFILE_FORM_INVITE =
  'On va compléter ton dossier — c’est lui qui me permet de retrouver ton profil et de ' +
  'préparer tes documents.';

export const PROFILE_FORM_CHANNEL_REDIRECT =
  "Le formulaire est personnel, je te l'envoie en message direct : écris-moi en privé " +
  '« complète mon profil » et je te l’ouvre.';

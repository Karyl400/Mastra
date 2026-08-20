import { normalizeIntentText } from './intent-text';

const PIN_MARKERS: readonly string[] = [
  'souviens toi que',
  'souviens toi de',
  'rappelle toi que',
  'retiens que',
  'note que',
  'n oublie pas que',
  'garde en tete que',
  'remember that',
];

export const MAX_PINNED_FACTS = 5;

export const MAX_PINNED_FACT_CHARS = 120;

const MAX_PIN_MESSAGE_LENGTH = 300;

export function extractPinnedFact(text: string | undefined | null): string | null {
  const raw = (text ?? '').trim();
  if (raw.length === 0 || raw.length > MAX_PIN_MESSAGE_LENGTH) return null;

  const normalized = normalizeIntentText(raw);

  const marker = PIN_MARKERS.find((candidate) => normalized.includes(`${candidate} `));
  if (!marker) return null;

  const markerWordCount = marker.split(' ').length;
  const before = normalized.slice(0, normalized.indexOf(marker));
  const skip = (before.trim() === '' ? 0 : before.trim().split(' ').length) + markerWordCount;

  const originalWords = raw.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const fact = originalWords.slice(skip).join(' ').trim();

  if (fact.length === 0) return null;

  return fact.length > MAX_PINNED_FACT_CHARS
    ? `${fact.slice(0, MAX_PINNED_FACT_CHARS - 1).trimEnd()}…`
    : fact;
}

export function pinnedFactReply(fact: string): string {
  return `C'est noté : « ${fact} ». Je m'en souviendrai jusqu'à ce que tu me demandes d'oublier.`;
}

export const PIN_FAILED_REPLY =
  "Je n'ai pas réussi à noter ça — ma mémoire est indisponible à l'instant. " +
  'Redis-le-moi dans un moment.';

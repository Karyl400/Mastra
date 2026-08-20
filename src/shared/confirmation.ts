const MAX_CHARS = 32;

function stripTrailingPunctuation(value: string): string {
  let end = value.length;
  while (end > 0 && (value[end - 1] === '.' || value[end - 1] === '!')) end -= 1;
  return value.slice(0, end);
}

function unifyApostrophes(value: string): string {
  return value.replace(/[\u2019\u02BC\u055A\u2032`\u00B4]/gu, "'");
}

function normalize(text: string): string {
  const folded = unifyApostrophes(text.trim())
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '');

  return stripTrailingPunctuation(folded).replace(/\s+/gu, ' ').trim();
}

function tooLongToBeAnAnswer(text: string): boolean {
  return text.trim().length > MAX_CHARS;
}

const YES = [
  /^oui$/u,
  /^oui,? (?:envoie|envoyer|vas-y|vas y|fais le|fais-le|c'est bon|parfait)$/u,
  /^(?:envoie|envoie-le|envoie le|envoyer)$/u,
  /^(?:vas-y|vas y|go|ok envoie|d'accord envoie)$/u,
  /^(?:je )?confirme$/u,
  /^c'est bon,? envoie$/u,
];

const NO = [
  /^non$/u,
  /^non,? (?:merci|pas maintenant|annule|laisse tomber|plus tard)$/u,
  /^(?:annule|annuler|annule-le|laisse tomber|pas maintenant|plus tard)$/u,
  /^(?:n'envoie pas|ne pas envoyer|surtout pas)$/u,
];

export function readsAsNo(text: string | undefined | null): boolean {
  const raw = text ?? '';
  if (tooLongToBeAnAnswer(raw)) return false;
  const value = normalize(raw);
  if (value.length === 0) return false;
  return NO.some((pattern) => pattern.test(value));
}

export function readsAsYes(text: string | undefined | null): boolean {
  const raw = text ?? '';
  if (tooLongToBeAnAnswer(raw)) return false;
  const value = normalize(raw);
  if (value.length === 0) return false;
  if (readsAsNo(value)) return false;
  return YES.some((pattern) => pattern.test(value));
}

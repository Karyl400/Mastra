import { isActingTool, toolsWithEffect } from '../../../../shared/agent-capabilities';

const DONE_VERBS =
  '(?:envoye|cree|genere|enregistre|programme|planifie|transmis|transmise|ajoute|publie|telecharge' +
  '|mis|mise|glisse|glissee|depose|deposee|joint|jointe|poste|postee|partage|partagee' +
  '|prepare|preparee|remis|remise|livre|livree)';

const RECEIVED_VERBS = '(?:recu|recue|recus|recues)';

function splitSentences(normalized: string): Array<{ text: string; delimiter: string }> {
  const parts = normalized.split(/([.!?]+)/);
  const sentences: Array<{ text: string; delimiter: string }> = [];

  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i];
    if (text) sentences.push({ text, delimiter: parts[i + 1] ?? '' });
  }

  return sentences;
}

function assertiveText(normalized: string): string {
  return splitSentences(normalized)
    .filter((s) => !s.delimiter.includes('?'))
    .map((s) => s.text)
    .join(' . ');
}

const ACCOMPLISHMENT_CLAIMS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "c'est fait", pattern: /\bc'est (?:fait|bon|parti|envoye|en route|dans le fil)\b/ },
  {
    label: 'première personne',
    pattern: new RegExp(
      `\\b(?:j'ai|je t'ai|je l'ai|je lui ai|je vous ai|je les ai|je te l'ai|je te les ai) (?:bien |deja )?${DONE_VERBS}e?s?\\b`,
    ),
  },
  {
    label: 'je viens de',
    pattern:
      /\bje viens (?:de |d')(?:t'|l'|lui |vous |les )?(?:envoyer|creer|generer|enregistrer|programmer|planifier|transmettre|ajouter|publier|glisser|deposer|preparer|mettre)\b/,
  },
  {
    label: 'voix passive',
    pattern: new RegExp(`\\b(?:a|ont|t'a|lui a|vous a) (?:bien |deja )?ete ${DONE_VERBS}e?s?\\b`),
  },
  { label: 'est prêt', pattern: /\best (?:pret|prete|prets|pretes)\b/ },
  {
    label: 'mise à jour',
    pattern:
      /\b(?:est|sont) (?:maintenant |desormais |bien )?(?:a jour|mis a jour|mise a jour|mises a jour)\b/,
  },

  {
    label: 'voilà',
    pattern: /\bet voila\b|\bvoila[ ,:]+(?:ton|ta|tes|le|la|les|c'est|ce qui)\b/,
  },
  {
    label: 'ça y est',
    pattern: /(?<!que )(?<!si )\bca y est\b/,
  },
  {
    label: 'tu l’as',
    pattern: new RegExp(
      `\\b(?:tu l'as|tu les as|il l'a|elle l'a|vous l'avez) (?:bien |deja )?${RECEIVED_VERBS}\\b` +
        `|\\btu devrais (?:l'|le |la |les )?avoir\\b`,
    ),
  },
  {
    label: 't’attend',
    pattern: /(?<!je )\b(?:t'|vous )attend(?!s)\b/,
  },
  { label: 'en route', pattern: /\b(?:est|sont) en route\b|\ben route vers\b/ },
  {
    label: 'tout est bon',
    pattern: /\btout est (?:bon|regle|reglee|en place|en ordre|pret|prete)\b/,
  },
  { label: 'bonne nouvelle', pattern: /\bbonne nouvelle\s*[:,]/ },
  { label: 'n’a plus qu’à', pattern: /\bn'(?:a|as|ont|avez) plus (?:rien|qu'a)\b/ },
];

export const ACCOMPLISHMENT_CLAIM_LABELS: readonly string[] = ACCOMPLISHMENT_CLAIMS.map(
  (claim) => claim.label,
);

export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set(toolsWithEffect('read'));

export const ACTING_TOOL_NAMES: ReadonlySet<string> = new Set(toolsWithEffect('write'));

export function hasActingToolCall(toolCalls: readonly string[]): boolean {
  return toolCalls.some((name) => isActingTool(name));
}

export const UNSUPPORTED_CLAIM_NOTICE =
  "\n\n_Je me relis : je n'ai rien fait à ce tour. Si tu attendais un envoi, un document ou un enregistrement, il n'a pas eu lieu._";

export function normalizeForClaims(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/’/g, "'");
}

export function detectUnsupportedCompletionClaim(text: string): string | null {
  const normalized = assertiveText(normalizeForClaims(text));
  return ACCOMPLISHMENT_CLAIMS.find((claim) => claim.pattern.test(normalized))?.label ?? null;
}

export function readToolCallNames(response: unknown): string[] | null {
  const calls = (response as { toolCalls?: unknown } | undefined)?.toolCalls;
  if (!Array.isArray(calls)) return null;

  return calls.map((call) => {
    const chunk = call as { payload?: { toolName?: unknown }; toolName?: unknown; name?: unknown };
    return String(chunk.payload?.toolName ?? chunk.toolName ?? chunk.name ?? 'unknown');
  });
}

export function promisesWithoutActing(toolCalls: readonly string[]): boolean {
  return !hasActingToolCall(toolCalls);
}

const ENCLITIC = "(?:(?:le|la|lui|les|leur|vous|nous|te|me) |[ltm]')";

const SEND_VERBS_FUTURE = 'enverrai|transmettrai|expedierai|adresserai';

const FUTURE_DELIVERY_CLAIMS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  {
    label: 'sera envoyé',
    pattern:
      /\b(?:sera|seront) (?:bien |automatiquement )?(?:envoye|transmis|expedie|adresse|delivre)/,
  },
  { label: 'partira', pattern: /\b(?:partira|partiront)\b/ },
  {
    label: 'planifié',
    pattern: /\bplanifiee?s?\b/,
  },
  {
    label: 'programmé',
    pattern: /\b(?:est|ete|sera) (?:bien |deja )?programmee?s?\b/,
  },
  {
    label: 'tu recevras',
    pattern: /\btu (?:recevras|seras (?:prevenu|notifie))/,
  },
  {
    label: "je l'enverrai",
    pattern: new RegExp(`\\bje ${ENCLITIC}?${ENCLITIC}?(?:${SEND_VERBS_FUTURE})\\b`),
  },
  { label: 'recevra', pattern: /\b(?:recevra|recevront)\b/ },
];

const NEGATED_DELIVERY_PATTERNS: readonly RegExp[] = [
  /\b(?:rien|aucun|aucune) ne\b/,
  /\bne (?:sera|seront|serai) pas\b/,
  /\bne (?:partira|partiront)\b/,
  /\bn'est pas (?:planifie|programme|envoye)\b/,
  /\bne (?:recevras|recevra|recevrez)\b/,
  /\bn'enverra\b/,
  /\benverrai pas\b/,
  /\baucun automate\b/,
];

function negatesDelivery(sentence: string): boolean {
  return NEGATED_DELIVERY_PATTERNS.some((pattern) => pattern.test(sentence));
}

const HUMAN_GATED_PATTERN =
  /\b(?:apres|qu'apres|une fois) (?:ton |votre |le |la )?(?:clic|validation|confirmation)|\bne part(?:ira)? qu'apres\b|\bclic sur\b/;

export const PROMISED_DELIVERY_NOTICE =
  "\n\n_Je me relis : je n'ai rien enregistré à ce tour, donc rien ne partira. Redis-le-moi et je le note pour de bon._";

export function detectUnsupportedDeliveryPromise(text: string): string | null {
  const normalized = normalizeForClaims(text);
  if (HUMAN_GATED_PATTERN.test(normalized)) return null;

  const promissory = splitSentences(normalized)
    .filter((sentence) => !negatesDelivery(sentence.text))
    .map((sentence) => sentence.text)
    .join(' . ');

  return FUTURE_DELIVERY_CLAIMS.find((claim) => claim.pattern.test(promissory))?.label ?? null;
}

const DONE_VERBS =
  '(?:envoye|cree|genere|enregistre|programme|planifie|transmis|transmise|ajoute|publie|telecharge)';

const ACCOMPLISHMENT_CLAIMS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "c'est fait", pattern: /\bc'est (?:fait|bon|parti|envoye)\b/ },
  {
    label: 'première personne',
    pattern: new RegExp(
      `\\b(?:j'ai|je t'ai|je l'ai|je lui ai|je vous ai|je les ai) (?:bien |deja )?${DONE_VERBS}e?s?\\b`,
    ),
  },
  {
    label: 'je viens de',
    pattern:
      /\bje viens (?:de |d')(?:t'|l'|lui |vous |les )?(?:envoyer|creer|generer|enregistrer|programmer|planifier|transmettre|ajouter|publier)\b/,
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
];

export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'findEmployeeByEmail',
  'findPersonByName',
  'findExpertise',
  'getEmployeeProfile',
  'getNotificationHistory',
  'getUserConversations',
  'getChannelHistory',
]);

export const ACTING_TOOL_NAMES: ReadonlySet<string> = new Set([
  'generateDocument',
  'sendNotification',
  'scheduleReminder',
  'updateOnboardingStatus',
  'scheduleCandidateInterview',
]);

export function hasActingToolCall(toolCalls: readonly string[]): boolean {
  return toolCalls.some((name) => !READ_ONLY_TOOL_NAMES.has(name));
}

export const UNSUPPORTED_CLAIM_NOTICE =
  "\n\n_Note : aucune action n'a été exécutée à ce tour. Si tu attendais un envoi, un document ou un enregistrement, il n'a pas eu lieu._";

export function normalizeForClaims(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/’/g, "'");
}

export function detectUnsupportedCompletionClaim(text: string): string | null {
  const normalized = normalizeForClaims(text);
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

const NON_DELIVERING_TOOL_NAMES: ReadonlySet<string> = new Set(['scheduleReminder']);

export function onlyNonDeliveringTools(toolCalls: readonly string[]): boolean {
  const acting = toolCalls.filter((name) => !READ_ONLY_TOOL_NAMES.has(name));
  return acting.length > 0 && acting.every((name) => NON_DELIVERING_TOOL_NAMES.has(name));
}

const ENCLITIC = "(?:(?:le|la|lui|les|leur|vous) |t')";

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

const HUMAN_GATED_PATTERN =
  /\b(?:apres|qu'apres|une fois) (?:ton |votre |le |la )?(?:clic|validation|confirmation)|\bne part(?:ira)? qu'apres\b|\bclic sur\b/;

export const PROMISED_DELIVERY_NOTICE =
  "\n\n_Note : c'est enregistré, mais aucun automate ne l'enverra — il n'y en a aucun dans ce système. Reviens me le demander le moment venu._";

export function detectUnsupportedDeliveryPromise(text: string): string | null {
  const normalized = normalizeForClaims(text);
  if (HUMAN_GATED_PATTERN.test(normalized)) return null;
  return FUTURE_DELIVERY_CLAIMS.find((claim) => claim.pattern.test(normalized))?.label ?? null;
}

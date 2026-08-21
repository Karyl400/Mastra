const DONE_VERBS =
  '(?:envoye|cree|genere|enregistre|programme|planifie|transmis|transmise|ajoute|publie|telecharge' +
  '|mis|mise|glisse|glissee|depose|deposee|joint|jointe|poste|postee|partage|partagee' +
  '|prepare|preparee|remis|remise|livre|livree)';

const RECEIVED_VERBS = '(?:recu|recue|recus|recues)';

/**
 * ⚠️ UNE AFFIRMATION DANS UNE QUESTION N'EST PAS UNE AFFIRMATION.
 *
 * Ce filtre est passé AVANT tous les motifs, et il protège les six d'origine autant que ceux
 * ajoutés pour le ton de Marcel. Sans lui, « Tout est bon pour toi ? » et « Est-ce que ça y
 * est ? » se font requalifier — c'est-à-dire qu'on accole un démenti à une QUESTION, ce qui
 * n'a aucun sens pour la personne qui lit.
 *
 * Le contrat de ce détecteur est de constater une CONTRADICTION entre ce que la réponse
 * affirme et ce que la trace d'exécution montre. Une interrogation n'affirme rien : il n'y a
 * rien à contredire. Élargir les motifs sans poser ce filtre d'abord aurait multiplié les faux
 * positifs exactement à la vitesse où l'on gagnait en couverture.
 *
 * Les segments retenus sont recollés par « . » et non par un espace : sans séparateur, la fin
 * d'une phrase et le début de la suivante formeraient des expressions qu'aucune des deux ne
 * contient.
 */
function assertiveText(normalized: string): string {
  const parts = normalized.split(/([.!?]+)/);
  const kept: string[] = [];

  for (let i = 0; i < parts.length; i += 2) {
    const delimiter = parts[i + 1] ?? '';
    if (delimiter.includes('?')) continue;
    const segment = parts[i];
    if (segment) kept.push(segment);
  }

  return kept.join(' . ');
}

/**
 * ⚠️ LISTE FERMÉE, MAIS PLUS LARGE QU'ELLE NE L'ÉTAIT — et l'ordre des deux gestes compte.
 *
 * Ce dépôt avait REFUSÉ tout ton chaleureux, avec cet argument, consigné dans `CLAUDE.md` :
 * « un modèle invité à varier ses formules écrirait "voilà, ton document t'attend" — hors
 * motif, donc non requalifié. Demander de la variété au modèle DÉGRADE le seul détecteur de
 * fausses annonces. »
 *
 * L'argument est juste, et il n'interdit pas le ton : il interdit de changer le ton AVANT le
 * détecteur. Les familles ci-dessous sont donc les façons NATURELLES d'annoncer un travail
 * fait — celles qu'un collègue emploie et que les six motifs d'origine, tous construits sur
 * des tournures administratives, laissaient toutes passer.
 *
 * `tests/unit/notification/claim-detection-warmth.test.ts` verrouille les deux bords : ce qui
 * doit être attrapé, et ce qui ne doit surtout pas l'être.
 */
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

  // ⚠️ À partir d'ici : les formules de COLLÈGUE, ajoutées avec le ton de Marcel.
  {
    // « Voilà ce dont j'ai besoin » et « voilà pourquoi » sont des CHARNIÈRES de discours, pas
    // des annonces : le motif exige donc un livrable derrière, jamais « voila » nu.
    label: 'voilà',
    pattern: /\bet voila\b|\bvoila[ ,:]+(?:ton|ta|tes|le|la|les|c'est|ce qui)\b/,
  },
  {
    // « Est-ce que ça y est ? » est déjà écarté par le filtre interrogatif ; le lookbehind
    // couvre la forme sans point d'interrogation (« je me demande si ça y est »).
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
    // « je t'attends » n'est pas une livraison : le `s` final et le sujet « je » l'excluent.
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

/**
 * Les libellés, exposés pour qu'un test de ton puisse raisonner sur la COUVERTURE sans relire
 * les motifs. La liste d'origine était fermée ET muette : le seul moyen de savoir si une
 * formule était couverte était de dérouler les regex à la main.
 */
export const ACCOMPLISHMENT_CLAIM_LABELS: readonly string[] = ACCOMPLISHMENT_CLAIMS.map(
  (claim) => claim.label,
);

export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'findEmployeeByEmail',
  'findPersonByName',
  'findExpertise',
  'getEmployeeProfile',
  'getNotificationHistory',
  'getUserConversations',
  'getChannelHistory',
  'searchKnowledge',
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

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

/**
 * ⚠️ CETTE NOTE CONTREDIT MARCEL, donc elle doit parler comme lui — sans quoi le changement de
 * registre trahit à lui seul qu'une machine vient de reprendre la main.
 *
 * Elle s'ouvrait par « Note : » et disait « aucune action n'a été exécutée à ce tour » : deux
 * marques d'un système qui s'annote lui-même. Ce qui ne change PAS est ce qu'elle affirme —
 * l'aveu doit rester net, c'est toute sa raison d'être.
 */
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

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LA PRÉMISSE DE CE DÉTECTEUR A CHANGÉ LE 2026-08-21 — et c'est le point de méthode
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `onlyNonDeliveringTools` a été SUPPRIMÉE. Son ensemble ne contenait qu'un nom,
 * `scheduleReminder`, et sa raison d'être tenait en une phrase : ce tool enregistrait une
 * ligne que rien ne reprenait. Depuis que le cron quotidien existe
 * (`domain/services/reminder-dispatch.ts`), le rappel PART. Garder le garde-fou tel quel
 * reviendrait à faire démentir une phrase VRAIE — la faute exactement symétrique de celle
 * qu'il corrigeait.
 *
 * ⚠️ **Un détecteur encode le CÂBLAGE. Quand le câblage bouge, il doit bouger avec, sinon il
 * ment dans l'autre sens.** Même famille que `READ_ONLY_TOOL_NAMES`, qui gardait `getTaskList`
 * après son retrait et ignorait `findPersonByName` ajouté le même jour : un détecteur périmé
 * n'est pas neutre, il est faux.
 *
 * Ce qui RESTE vrai, et pourquoi la fonction n'est pas simplement effacée : promettre une
 * livraison alors qu'AUCUN outil agissant n'a tourné reste un mensonge. La condition passe donc
 * de « seuls des outils non livrants ont tourné » à « aucun outil agissant n'a tourné ». Le
 * même garde-fou, sur la seule prémisse qui tienne encore.
 */
export function promisesWithoutActing(toolCalls: readonly string[]): boolean {
  return !hasActingToolCall(toolCalls);
}

/**
 * ⚠️ **`l'` MANQUAIT, et avec lui les DEUX formes les plus courantes en français** — trouvé le
 * 2026-08-21 en écrivant le test de la prémisse retournée. La liste tenait `le `, `la `, `vous `
 * et l'élidé `t'`, mais pas l'élidé `l'` : « je te **l'**enverrai lundi » et « je vous
 * **l'**enverrai » n'étaient détectés par RIEN. Le motif couvrait « je le enverrai », que
 * personne n'écrit, et manquait ce que tout le monde écrit.
 *
 * Même famille que « je veux en finir », absent du détecteur de détresse jusqu'au même jour :
 * une liste rédigée d'un trait couvre ce qu'on a en tête, pas ce que les gens tapent. Le seul
 * remède est de l'exercer sur des phrases réelles — d'où les formes énumérées dans
 * `tests/unit/notification/promised-delivery.test.ts`.
 */
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

/**
 * ⚠️ UNE PHRASE QUI NIE LA LIVRAISON EST LE CONTRAIRE D'UNE PROMESSE DE LIVRAISON.
 *
 * Relevé en production le 2026-08-21, sur une sonde `scheduleReminder`. Le modèle a répondu
 * exactement ce qu'on lui demande — « Aucun automate ne l'enverra, rien ne partira tout seul
 * le moment venu » — et le motif `partira` s'est déclenché dessus. Une note a donc été accolée
 * pour redire la même chose, en moins bien : la personne lisait l'information deux fois, la
 * seconde sous forme de démenti administratif.
 *
 * C'est la famille de défaut corrigée dans `forget.ts` le 2026-08-13, où « je ne veux surtout
 * pas que tu oublies » DÉCLENCHAIT l'effacement : un verbe lu sans sa négation dit l'inverse
 * de la phrase qui le porte.
 *
 * ⚠️ LE FILTRE EST APPLIQUÉ PHRASE PAR PHRASE, jamais au message entier — à la différence de
 * `HUMAN_GATED_PATTERN`, qui court-circuite globalement. Sinon il suffirait d'ajouter « rien ne
 * part tout seul » n'importe où pour faire taire le détecteur sur tout le reste du message,
 * c'est-à-dire d'offrir une formule magique à ce qu'on surveille.
 */
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

// ⚠️ Une LISTE et non une seule alternation : le motif unique franchissait le seuil de
// complexité du linter (21 pour 20), et surtout il devenait illisible — or c'est un garde-fou
// qu'on relira en cherchant pourquoi une phrase n'a pas été attrapée. Un test par formule.
function negatesDelivery(sentence: string): boolean {
  return NEGATED_DELIVERY_PATTERNS.some((pattern) => pattern.test(sentence));
}

const HUMAN_GATED_PATTERN =
  /\b(?:apres|qu'apres|une fois) (?:ton |votre |le |la )?(?:clic|validation|confirmation)|\bne part(?:ira)? qu'apres\b|\bclic sur\b/;

/**
 * ⚠️ **CETTE NOTE A CHANGÉ DE SENS LE 2026-08-21, parce que le produit a changé.**
 *
 * Elle disait : « je ne sais pas te relancer tout seul le jour venu — repasse me le demander ».
 * C'était exact et c'était le défaut : ce n'est pas ce qu'on attend d'un rappel. Le cron
 * quotidien le fait désormais partir, donc la note n'a plus à s'excuser — elle a à dire QUAND,
 * puisque la remise a lieu le matin et non à l'heure demandée.
 *
 * Elle ne s'accole que lorsqu'une promesse de livraison a été faite SANS qu'aucun outil
 * agissant n'ait tourné : là, rien n'a été enregistré, donc rien ne partira.
 */
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

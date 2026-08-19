/**
 * OUI ou NON — le seul endroit du dépôt où un mot déclenche un acte irréversible.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * L'asymétrie qui gouverne tout ce module
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Rater un « oui » fait répéter la personne : coût nul, et elle voit qu'il ne s'est rien passé.
 * En inventer un fait partir un email à un CANDIDAT, depuis l'adresse de l'entreprise, et rien
 * ne le rattrape. Le détecteur est donc STRICT et court : on préfère cent fois redemander.
 *
 * C'est l'arbitrage inverse de `claimsProfileDone`, qui doit être large — là-bas, un faux
 * négatif est un cul-de-sac ; ici, un faux positif est irréversible.
 *
 * ⚠️ BORNE DE LONGUEUR. Une confirmation est courte par nature. « oui, mais avant ça peux-tu
 * changer la date ? » commence par « oui » et demande le CONTRAIRE d'un envoi — c'est la même
 * famille de piège que « je ne veux surtout pas que tu oublies », qui effaçait les données de
 * quelqu'un qui demandait l'inverse. Au-delà de la borne, on ne tranche pas : on redemande.
 *
 * ⚠️ `\p{L}` avec le drapeau `u`, jamais `\b` — ce dépôt a payé quatre fois ce piège, `\b`
 * raisonnant en ASCII et ne matchant aucune frontière après un caractère accentué.
 */

/** Une confirmation tient en quelques mots. Au-delà, c'est une phrase, donc une nuance. */
const MAX_CHARS = 32;

/**
 * ⚠️ Une BOUCLE et non `/[.!]+$/`. Le motif ancré à quantificateur rebrousse chemin à chaque
 * position sur « !!!!!…x » : son coût est super-linéaire, et cette fonction tourne sur CHAQUE
 * message Slack — jusqu'à 40 000 caractères. L'écrire en boucle le rend linéaire par
 * construction plutôt que par une garde placée ailleurs : c'est la même leçon que le `\b`
 * ASCII, un motif dont le coût réel ne se lit pas dans le motif.
 */
function stripTrailingPunctuation(value: string): string {
  let end = value.length;
  while (end > 0 && (value[end - 1] === '.' || value[end - 1] === '!')) end -= 1;
  return value.slice(0, end);
}

/**
 * ⚠️ LES DEUX APOSTROPHES SONT LA MÊME. Slack, iOS et Android produisent l'apostrophe
 * TYPOGRAPHIQUE (U+2019) ; les motifs ci-dessous sont écrits avec l'apostrophe droite. Sans
 * cette unification, « n’envoie pas » — tapé sur un téléphone, c'est-à-dire le cas le plus
 * fréquent — n'était reconnu par AUCUN motif de refus : le message repartait chez l'agent et
 * l'email restait en attente alors que la personne venait de dire non.
 */
function unifyApostrophes(value: string): string {
  return value.replace(/[\u2019\u02BC\u055A\u2032`\u00B4]/gu, "'");
}

function normalize(text: string): string {
  const folded = unifyApostrophes(text.trim())
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '');

  // ⚠️ Le TRIM FINAL n'est pas décoratif : « Oui ! » devient « oui  » une fois le point
  // d'exclamation retiré, et `/^oui$/` ne le reconnaissait pas. Défaut présent depuis
  // l'écriture du module — la ponctuation était retirée, l'espace qui la précédait non.
  return stripTrailingPunctuation(folded).replace(/\s+/gu, ' ').trim();
}

/**
 * ⚠️ LA LONGUEUR EST MESURÉE SUR LE TEXTE BRUT, jamais sur le texte normalisé.
 *
 * La normalisation retire la ponctuation finale : « oui » suivi de cinq mille points
 * d'exclamation se réduisait donc à « oui », trois caractères, et franchissait une borne
 * écrite pour dire « une confirmation tient en quelques mots ». Une borne qu'on applique
 * APRÈS avoir raccourci ne borne rien.
 */
function tooLongToBeAnAnswer(text: string): boolean {
  return text.trim().length > MAX_CHARS;
}

/**
 * ⚠️ ANCRÉS DES DEUX BOUTS. « oui » suivi de n'importe quoi n'est pas une confirmation : la
 * borne de longueur ne suffirait pas seule, « oui mais non » tenant largement dessous.
 */
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

/**
 * ⚠️ Une négation ANNULE une affirmation, jamais l'inverse. « non, envoie » n'existe pas dans
 * la langue ; « oui, n'envoie pas » est une hésitation. On teste donc le refus EN PREMIER.
 */
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

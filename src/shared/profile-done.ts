/**
 * « J'ai fini » — dire qu'on a terminé, plutôt que de cliquer.
 *
 * ## Pourquoi ce chemin existe
 *
 * Le guide d'accueil écrit dit, mot pour mot : « Reviens ici et clique sur "C'est fait" —
 * ou écris-moi simplement "j'ai fini" ». Tant que ce prédicat n'existait pas, cette phrase
 * était une PROMESSE CREUSE, c'est-à-dire précisément le défaut que ce dépôt traque partout
 * ailleurs : l'email de bienvenue a perdu « vous recevrez prochainement les accès »,
 * `scheduleReminder` a cessé de dire « planifié », et la ligne sur la vidéo disparaît tant
 * qu'aucune URL n'est configurée. Un texte qui annonce un chemin doit être accompagné du
 * chemin.
 *
 * ## Le critère : un ACTE DE LANGAGE, pas la présence de mots
 *
 * Même discipline que `forget.ts`, dont une revue adversariale avait REPRODUIT une perte de
 * données parce que la négation était séparée du verbe. Ici l'enjeu est moindre — un faux
 * positif déclenche une VÉRIFICATION, opération en lecture seule qui répond honnêtement
 * « il me manque ton poste » ou « ton dossier est complet ». L'asymétrie est donc inverse de
 * celle de l'effacement, et elle penche vers la tolérance :
 *
 *  - faux positif  → une vérification inutile, un message informatif, rien de perdu ;
 *  - faux négatif  → la personne a suivi l'instruction écrite et le bot ne répond pas, ce
 *                    qui lui apprend que les instructions du bot ne valent rien.
 *
 * On reste néanmoins sur une forme AFFIRMATIVE et COURTE : « j'ai fini de rédiger le
 * rapport, tu peux le relire ? » n'annonce pas la fin du profil, et une phrase longue parle
 * d'autre chose.
 */

/** Minuscules, accents et apostrophes normalisés — comme les autres prédicats du dépôt. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[’´`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Longueur au-delà de laquelle on ne considère plus que la phrase annonce la fin du profil.
 *
 * ⚠️ La borne est le vrai discriminant, bien plus que la liste de formules. « c'est fait »
 * est une phrase entière ; « c'est fait, mais j'ai un souci avec le canal #signals et je
 * voulais aussi te demander… » est une conversation, et y répondre par une vérification de
 * dossier serait à côté.
 */
const MAX_CHARS = 48;

/**
 * Formules d'ACHÈVEMENT. Liste FERMÉE, ancrée au DÉBUT du message — même règle que le verbe
 * impératif de `forget.ts` : ce qui ouvre le message est ce qu'il vient dire.
 *
 * Volontairement ABSENTS :
 *  - « fini » nu — c'est un mot de fin de journée autant que de tâche ;
 *  - « ok », « voilà » — ils accusent réception de n'importe quoi ;
 *  - « je vais le faire », « bientôt fini » — ce sont des intentions, pas des achèvements.
 */
const DONE_PATTERNS: readonly RegExp[] = [
  /^(?:c'est|cest) (?:fait|bon|termine|fini|complete)\b/,
  /^j'?ai (?:fini|termine|complete|rempli)\b/,
  // ⚠️ Alternation PLATE plutôt que deux groupes optionnels enchaînés
  // (`^(?:voila,? )?(?:c'est )?fini`) : la seconde forme est bornée et inoffensive, mais elle
  // déclenche `security/detect-unsafe-regex`, et ce dépôt tient son lint à ZÉRO warning — une
  // exception ici rendrait la règle inaudible ailleurs. « c'est fini » seul est déjà couvert
  // par le premier motif.
  /^voila,? (?:c'est )?fini\b/,
  /^(?:je l'ai|je viens de le) (?:fait|faite|rempli|complete)\b/,
  /^(?:profil|dossier|formulaire) (?:complete|rempli|fait|termine)\b/,
  /^(?:fait|termine)\s*!*$/,
  // ⚠️ Ajoutés le 2026-08-19, quand cette liste est devenue la SEULE porte d'entrée du
  // parcours : le bouton « C'est fait » a été retiré. Une formule non reconnue n'est plus une
  // gêne, c'est un cul-de-sac — le message part chez un agent qui n'a aucune idée de ce que la
  // personne vient d'accomplir, et l'accueil s'arrête là.
  /^(?:ok|okay|voila|bon),? ?(?:c'est|cest) (?:fait|bon|termine|fini|pret|complete)\b/,
  /^(?:c'est|cest) pret\b/,
  /^ca y est\b/,
];

/**
 * ⚠️ La NÉGATION annule, et la garde est nécessaire : « je n'ai pas fini » commence par une
 * formule de la liste une fois la négation retirée par la normalisation des espaces. C'est
 * le même piège, dans une forme plus bénigne, que celui qui faisait effacer les données de
 * quelqu'un qui demandait le CONTRAIRE.
 */
const NEGATION =
  /\bn(?:e |')(?:ai|est|arrive)|\bpas (?:encore )?(?:fini|termine|fait)|\bpas fini\b/;

export function claimsProfileDone(text: string | undefined | null): boolean {
  const normalized = normalize(text ?? '');
  if (!normalized || normalized.length > MAX_CHARS) return false;
  if (NEGATION.test(normalized)) return false;
  return DONE_PATTERNS.some((pattern) => pattern.test(normalized));
}

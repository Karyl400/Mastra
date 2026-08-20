import { normalizeIntentText } from '../../../../shared/intent-text';

/**
 * QUELQU'UN VIENT DE SE DÉCLARER AU SOMMET — le dire au sommet.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Ce que ce module N'EST PAS, et il faut le lire avant le reste
 * ════════════════════════════════════════════════════════════════════════════
 *
 * **Ce prédicat n'accorde RIEN.** Il ne participe à aucune décision d'autorisation, et c'est
 * ce qui rend acceptable qu'il repose sur une chaîne de caractères saisie par la personne
 * elle-même. Le seul fait qui accorde `full` est `slack_directory.role`, écrit délibérément
 * hors du produit (`npm run role:set`) — précisément parce qu'un champ déclaratif ne doit
 * jamais fonder un droit.
 *
 * Ce module produit un SIGNAL, adressé à un humain : « cette personne s'est présentée comme
 * General Manager — es-tu au courant, approuves-tu ? » C'est la même distinction que le dépôt
 * fait déjà entre `title` (« Product Manager » sur quelqu'un qui n'est pas le manager) et
 * `role`. Confondre les deux serait l'élévation de privilège la plus simple qui soit : taper
 * son titre.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * L'ASYMÉTRIE, qui fixe la largeur du filet
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Un faux POSITIF coûte un DM au manager, qu'il lit en trois secondes et ignore.
 * Un faux NÉGATIF laisse une déclaration au sommet passer inaperçue.
 *
 * Le filet penche donc vers l'inclusion — mais pas au point d'attraper « Product Manager » ni
 * « Engineering Manager », qui désignent des métiers réels de ce workspace et déclencheraient
 * à chaque arrivée. La liste est FERMÉE et porte sur des locutions ENTIÈRES, jamais sur le
 * mot « manager » seul : c'est le même critère d'ancrage que `matchesKeyword`, où
 * `String.includes('test')` capturait « contestation ».
 */

/**
 * Locutions qui désignent le sommet de l'organisation, normalisées (sans accent, minuscules).
 *
 * ⚠️ « manager » seul en est ABSENT, et c'est délibéré : trois personnes sur six portent un
 * titre qui contient ce mot. « directeur » seul aussi — « directeur technique » n'est pas le
 * General Manager.
 */
/** Tout ce qui n'est ni lettre ni chiffre sépare deux mots — Unicode, jamais `[a-z0-9]`. */
const WORD_SEPARATOR = /[^\p{L}\p{N}]+/u;

const TOP_ROLE_PHRASES: readonly string[] = [
  'general manager',
  'directeur general',
  'directrice generale',
  'direction generale',
  'chief executive',
  'ceo',
  'pdg',
];

/**
 * Le poste déclaré désigne-t-il le sommet de l'organisation ?
 *
 * ⚠️ Comparaison sur des locutions ENTIÈRES, jamais par `includes` nu : sans ancrage, « ceo »
 * capturerait n'importe quel mot le contenant, et le dépôt a déjà payé ce défaut trois fois
 * (`\b` en ASCII, `includes('test')`, `endsWith(org)`).
 *
 * ⚠️ Le découpage en MOTS remplace une expression régulière, et ce n'est pas qu'une question
 * de lint. Une `RegExp` construite depuis une variable — même une constante de ce module —
 * est un motif que personne ne relit tel qu'il s'exécute ; et l'ancrage `\b` aurait été faux
 * ici, `\b` raisonnant en ASCII et ne reconnaissant pas `é` comme une lettre (quatrième
 * occurrence de ce piège dans ce dépôt). Encadrer d'espaces une suite de mots normalisés
 * donne la même garantie, en se lisant du premier coup.
 */
export function declaresTopRole(position: string | null | undefined): boolean {
  const normalized = normalizeIntentText(position ?? '');
  if (normalized.length === 0) return false;

  const words = normalized.split(WORD_SEPARATOR).filter(Boolean);
  if (words.length === 0) return false;

  const haystack = ` ${words.join(' ')} `;
  return TOP_ROLE_PHRASES.some((phrase) => haystack.includes(` ${phrase} `));
}

/**
 * Ce qu'on écrit au manager en place.
 *
 * ⚠️ Il DIT ce que la déclaration ne fait pas. Sans cette phrase, le message se lirait comme
 * une alerte de sécurité — « quelqu'un s'est donné les pleins pouvoirs » — alors que rien n'a
 * changé : le rôle est ailleurs, et il n'a pas bougé. Annoncer un danger qui n'existe pas est
 * la même famille de mensonge que d'en taire un.
 *
 * ⚠️ Il nomme le geste EXACT à faire si la réponse est oui. Un message qui demande d'approuver
 * sans dire comment laisse son destinataire chercher — et c'est ainsi qu'une approbation
 * n'arrive jamais.
 *
 * ZÉRO token : texte écrit en dur, aucun modèle sur ce chemin.
 */
export function topRoleClaimNotice(input: {
  readonly newcomerName: string;
  readonly declaredPosition: string;
  readonly slackUserId: string;
}): string {
  return (
    `*${input.newcomerName}* vient de compléter son dossier en se déclarant ` +
    `« ${input.declaredPosition} ».\n\n` +
    `Je te préviens parce que c'est le poste qui te désigne. *Rien n'a changé de son côté* : ` +
    `un intitulé de poste n'accorde aucun droit ici, elle reste sur son seul dossier.\n\n` +
    `Tu es au courant, et tu approuves ? Si oui, la portée se donne à la main :\n` +
    `\`npm run role:set -- --slack-user-id ${input.slackUserId} --apply\`\n` +
    `Si non, il n'y a rien à défaire — dis-le-lui simplement.`
  );
}

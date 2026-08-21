import { normalizeIntentText } from './intent-text';
import { ESCALATION_CONTACT } from './escalation';

const ERASURE_STEMS: readonly string[] = ['oubli', 'supprim', 'efface', 'delete', 'forget'];

const REQUEST_MARKERS: readonly string[] = [
  'peux tu',
  'tu peux',
  'pourrais tu',
  'tu pourrais',
  'merci de',
  'veux que',
  'aimerais que',
  'faut que',
  'please',
];

const REQUEST_LOOKBACK_WORDS = 3;

const NEGATION_WINDOW_WORDS = 4;

const MEMORY_OBJECTS: readonly string[] = [
  'ce que je t ai dit',
  'ce que je tai dit',
  'ce que je viens de dire',
  'ce que tu sais de moi',
  'ce que tu sais sur moi',
  'ce que tu as retenu',
  'ce que tu as memorise',
  'ce que je t ai raconte',
  'mes donnees',
  'mes informations',
  'mes messages',
  'notre conversation',
  'nos conversations',
  'nos echanges',
  'cette conversation',
  'ta memoire',
  'ton historique',
  'l historique de notre',
  'my data',
  'everything i told you',
  'this conversation',
];

const NEGATIONS: ReadonlySet<string> = new Set([
  'ne',
  'n',
  'pas',
  'sans',
  'jamais',
  'aucun',
  'aucune',
  'rien',
  'surtout',
  'never',
  'dont',
]);

const MAX_ERASURE_LENGTH = 200;

function isNegated(words: readonly string[], verbIndex: number): boolean {
  const from = Math.max(0, verbIndex - NEGATION_WINDOW_WORDS);
  const to = Math.min(words.length, verbIndex + NEGATION_WINDOW_WORDS + 1);

  for (let i = from; i < to; i += 1) {
    if (i !== verbIndex && NEGATIONS.has(words[i])) return true;
  }

  return false;
}

function isAnOrder(words: readonly string[], verbIndex: number): boolean {
  if (verbIndex === 0) return true;

  const before = words.slice(Math.max(0, verbIndex - REQUEST_LOOKBACK_WORDS), verbIndex).join(' ');
  return REQUEST_MARKERS.some((marker) => before.includes(marker));
}

function isErasureVerb(word: string): boolean {
  return ERASURE_STEMS.some((stem) => word.startsWith(stem));
}

export function requestsErasure(text: string | undefined | null): boolean {
  const raw = (text ?? '').trim();
  if (raw.length === 0 || raw.length > MAX_ERASURE_LENGTH) return false;

  const normalized = normalizeIntentText(raw);

  if (!MEMORY_OBJECTS.some((object) => normalized.includes(object))) return false;

  const words = normalized.split(' ');

  return words.some(
    (word, index) => isErasureVerb(word) && isAnOrder(words, index) && !isNegated(words, index),
  );
}

/**
 * ⚠️ **CETTE PHRASE A RÉTRÉCI LE 2026-08-21, parce que le produit sait faire plus.**
 *
 * Elle nommait « les messages que j'ai archivés dans les canaux » parmi ce qui ne partait pas.
 * C'était vrai — `forgetUser` était implémentée quatre fois et appelée zéro fois — mais le
 * renvoi vers le General Manager pointait alors vers **un geste sans implémentation** : il
 * aurait dû écrire du SQL à la main sur la Turso de production.
 *
 * Désormais, en DM, l'archive de CE canal part avec le reste. Ce qui subsiste hors de portée
 * est nommé, et il existe pour chacun un geste réel :
 *   • les canaux → `npm run knowledge:forget -- --user <U…>` (dry-run par défaut) ;
 *   • le dossier, l'annuaire, les documents, les notifications → toujours l'escalade humaine.
 *
 * ⚠️ **On ne dit pas « tout est effacé ».** Le contrat de ce court-circuit est de nommer ce
 * qu'il NE couvre pas — c'est la seule raison pour laquelle on peut lui faire confiance sur ce
 * qu'il couvre.
 */
export const ERASURE_SCOPE_NOTICE =
  'Ça ne touche que ce que je garde de nos échanges ici. Les documents déjà produits, les ' +
  "notifications déjà envoyées, ta fiche dans l'annuaire, ce que tu m'as dit de ton métier " +
  "lors de l'accueil et ce que j'ai archivé dans les canaux ne passent pas par moi — pour " +
  `ceux-là, adresse-toi à ${ESCALATION_CONTACT}.`;

/**
 * ⚠️ **ON NE DIT PLUS COMBIEN — demandé par le propriétaire le 2026-08-21.**
 *
 * La réponse annonçait « C'est effacé : 4 messages … ont été supprimés ». Le chiffre ne rendait
 * aucun service à qui le lisait, et il en rendait un à qui SONDE : il mesure ce que le bot avait
 * gardé, donc l'activité passée d'une personne — dans un DM où le manager peut par ailleurs
 * relire l'archive. Un compte est une information sur la donnée, pas seulement sur le geste.
 *
 * ⚠️ **On garde en revanche la distinction VIDE / NON VIDE.** « Je n'avais rien retenu » et
 * « c'est effacé » ne sont pas la même phrase : la première dit qu'il n'y avait rien, la seconde
 * qu'il y avait quelque chose et que c'est parti. Les fondre ferait dire « c'est effacé » à un
 * geste qui n'a rien effacé — la famille de mensonge que ce dépôt traque, et exactement ce que
 * ce court-circuit a été écrit pour ne plus faire.
 */
export function erasureDoneReply(count: number): string {
  if (count === 0) {
    return `Je n'avais rien retenu de nos échanges. ${ERASURE_SCOPE_NOTICE}`;
  }

  return `C'est effacé : je ne garde plus rien de nos échanges. ${ERASURE_SCOPE_NOTICE}`;
}

export const ERASURE_FAILED_REPLY =
  "Je n'ai pas réussi à effacer ce que j'avais gardé de nos échanges — ma mémoire est " +
  `indisponible à l'instant. Redemande-le-moi dans un moment, ou signale-le à ${ESCALATION_CONTACT}.`;

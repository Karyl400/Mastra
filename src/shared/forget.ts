import { normalizeIntentText } from './intent-text';
import { isNegatedNear } from './negation';
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
  'never',
  'dont',
]);

const MAX_ERASURE_LENGTH = 200;

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
    (word, index) =>
      isErasureVerb(word) && isAnOrder(words, index) && !isNegatedNear(words, index, NEGATIONS),
  );
}

export const ERASURE_SCOPE_NOTICE =
  'Ça ne touche que ce que je garde de nos échanges ici. Les documents déjà produits, les ' +
  "notifications déjà envoyées, ta fiche dans l'annuaire, ce que tu m'as dit de ton métier " +
  "lors de l'accueil et ce que j'ai archivé dans les canaux ne passent pas par moi — pour " +
  `ceux-là, adresse-toi à ${ESCALATION_CONTACT}.`;

export function erasureDoneReply(count: number): string {
  if (count === 0) {
    return `Je n'avais rien retenu de nos échanges. ${ERASURE_SCOPE_NOTICE}`;
  }

  return `C'est effacé : je ne garde plus rien de nos échanges. ${ERASURE_SCOPE_NOTICE}`;
}

export const ERASURE_FAILED_REPLY =
  "Je n'ai pas réussi à effacer ce que j'avais gardé de nos échanges — ma mémoire est " +
  `indisponible à l'instant. Redemande-le-moi dans un moment, ou signale-le à ${ESCALATION_CONTACT}.`;

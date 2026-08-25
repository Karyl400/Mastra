import { routeToAgent } from './agent-routing';

export const MAX_CHAIN_LENGTH = 2;

export type ChainRefusal = 'too_many_intents' | 'refers_back';

export interface IntentStep {
  readonly text: string;
  readonly agentId: string;
}

export interface IntentChainPlan {
  readonly steps: readonly IntentStep[];
  readonly refused?: ChainRefusal;
}

const CONNECTOR = /\s(?:et(?:\sensuite|\spuis)?|puis|ensuite)\s/i;

const MIN_FRAGMENT_LENGTH = 8;

const ACTION_VERBS = [
  'rappelle',
  'rappelles',
  'envoie',
  'envoies',
  'programme',
  'programmes',
  'planifie',
  'planifies',
  'génère',
  'genere',
  'crée',
  'cree',
  'prépare',
  'prepare',
  'note',
  'mets',
  'ajoute',
  'résume',
  'resume',
  'montre',
  'donne',
  'trouve',
  'retrouve',
  'cherche',
  'recherche',
  'fais',
  'qui',
] as const;

// eslint-disable-next-line security/detect-non-literal-regexp
const ACTION_HEAD = new RegExp(`^(?:${ACTION_VERBS.join('|')})(?!\\p{L})`, 'iu');

const BACK_REFERENCES = [
  'ça',
  'ca',
  'cela',
  'ceci',
  'ce résumé',
  'ce resume',
  'ce résultat',
  'ce resultat',
  'ce document',
  'ce fichier',
  'ce texte',
  'le tout',
  'ce que tu viens',
] as const;

// eslint-disable-next-line security/detect-non-literal-regexp
const REFERS_BACK = new RegExp(
  `(?<!\\p{L})(?:${BACK_REFERENCES.join('|')})(?!\\p{L})|[- ](?:le|la|les)[- ](?:moi|lui|nous|leur)(?!\\p{L})`,
  'iu',
);

export function refersToPreviousStep(fragment: string): boolean {
  return REFERS_BACK.test(fragment);
}

export function splitIntents(text: string): string[] {
  return (text ?? '')
    .split(CONNECTOR)
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length >= MIN_FRAGMENT_LENGTH && ACTION_HEAD.test(fragment));
}

export function planIntentChain(text: string, stickyAgentId?: string): IntentChainPlan | null {
  const raw = (text ?? '').trim();
  if (!raw) return null;

  const fragments = splitIntents(raw);
  if (fragments.length < 2) return null;

  const steps = fragments.map((fragment) => ({
    text: fragment,
    agentId: routeToAgent(fragment, stickyAgentId),
  }));

  if (new Set(steps.map((step) => step.agentId)).size < 2) return null;

  if (steps.length > MAX_CHAIN_LENGTH) {
    return { steps: [], refused: 'too_many_intents' };
  }

  if (steps.slice(1).some((step) => refersToPreviousStep(step.text))) {
    return { steps: [], refused: 'refers_back' };
  }

  return { steps };
}

export const REFERS_BACK_REPLY =
  'Tu me demandes deux choses, et la seconde s’appuie sur la première. Je traite chaque demande ' +
  'séparément — je ne fais donc pas passer le résultat de l’une dans l’autre. Dis-moi laquelle ' +
  'tu veux que je fasse en premier, ou redis la seconde en nommant ce qu’elle vise.';

export const TOO_MANY_INTENTS_REPLY =
  'Tu me demandes plus de deux choses d’un coup, et je préfère te le dire plutôt que d’en ' +
  'faire la moitié : reprends-les en deux messages, je m’en occupe.';

export const CHAIN_STOPPED_NOTICE =
  'Je m’arrête là : la première demande n’a pas abouti, donc je n’ai pas enchaîné sur la ' +
  'seconde — la traiter dans le vide ne t’avancerait à rien. Redis-la-moi seule si tu la veux ' +
  'quand même.';

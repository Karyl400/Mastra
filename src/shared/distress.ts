import { normalizeIntentText } from './intent-text';

const DISTRESS_PHRASES: readonly string[] = [
  'je veux mourir',
  'je veux meurir',
  'envie de mourir',
  'envie d en finir',
  'en finir avec la vie',
  'me suicider',
  'suicide',
  'me faire du mal',
  'idees noires',
  'plus envie de vivre',
  'a quoi bon vivre',

  'je ne vais pas bien',
  'je vais tres mal',
  'je vais pas bien',
  'je craque',
  'je suis a bout',
  'burn out',
  'burnout',
  'depression',
  'je suis deprime',

  'harcele',
  'harcelement',
  'harcelement moral',
  'harcelement sexuel',
  'je suis agresse',
  'agression sexuelle',
  'me menace',
  'me harcele',
  'discrimination',
  'je suis discrimine',
];

const MAX_DISTRESS_LENGTH = 2000;

export function detectsDistress(text: string | undefined | null): boolean {
  const raw = (text ?? '').trim();
  if (raw.length === 0 || raw.length > MAX_DISTRESS_LENGTH) return false;

  const normalized = normalizeIntentText(raw);
  return DISTRESS_PHRASES.some((phrase) => normalized.includes(phrase));
}

export const DISTRESS_REPLY =
  "Je suis un outil d'onboarding, je ne suis pas la bonne personne pour ça — mais je ne vais " +
  'pas te laisser sans réponse.\n\n' +
  "Si c'est urgent : *0800 0787 746* (SURPIN, gratuit, 24h/24, partout au Nigeria), ou le " +
  '*112* si la vie de quelqu’un est en jeu maintenant.\n' +
  'Pour une situation au travail — harcèlement, conflit, souffrance — tu peux en parler à ' +
  "l'équipe RH de Kisso, ou à quelqu'un en qui tu as confiance dans le workspace.\n\n" +
  "Je n'ai pas transmis ce message : il reste entre nous.";

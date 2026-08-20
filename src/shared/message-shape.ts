const CARRIES_MEANING = /[\p{L}\p{N}]/u;

export function hasNoTextualContent(text: string | undefined | null): boolean {
  return !CARRIES_MEANING.test(text ?? '');
}

export const CONTENT_FREE_REPLY =
  "Je n'ai rien à traiter dans ce message. Dis-moi en quelques mots ce dont tu as besoin.";

export const CONTENT_FREE_REPLIES: readonly string[] = [
  CONTENT_FREE_REPLY,
  "Il n'y a rien à lire là-dedans pour moi. Dis-moi en deux mots ce que tu attends.",
  "Je ne vois aucun texte à traiter. Qu'est-ce que je peux faire pour toi ?",
];

export const TOO_LONG_REPLY =
  'Ton message est trop long pour que je le traite en une fois. Résume-le, ou dis-moi ' +
  "seulement ce que tu attends de moi et je m'en occupe.";

export const TOO_LONG_REPLIES: readonly string[] = [
  TOO_LONG_REPLY,
  "C'est trop long pour moi d'un seul bloc. Garde l'essentiel, ou dis-moi juste ce que tu " +
    'attends et je me débrouille.',
  'Je cale sur la longueur. Envoie-moi la version courte — ce que tu veux obtenir suffit.',
];

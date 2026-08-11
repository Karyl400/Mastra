import { DocumentFormat } from '../../../../shared/types';

/**
 * Nom de fichier et type MIME d'un document rendu.
 *
 * Ces deux valeurs SORTENT du processus : le nom devient celui du fichier posté
 * dans Slack et celui de la pièce jointe email. Un titre est rédigé par un LLM à
 * partir d'un texte utilisateur — il peut donc contenir n'importe quoi, y compris
 * `../`, un `/`, un `\0` ou une chaîne vide. On ne fait pas confiance au titre :
 * on en dérive un nom, on ne le reprend jamais tel quel.
 */

/** Repli quand le titre est vide ou entièrement filtré — jamais de chaîne vide. */
export const FALLBACK_DOCUMENT_BASENAME = 'document';

/**
 * Longueur maximale de la base du nom. eCryptfs plafonne à 143 octets et
 * plusieurs clients mail tronquent au-delà de 100 : 80 laisse de la marge à
 * l'extension tout en gardant un nom lisible.
 */
const MAX_BASENAME_LENGTH = 80;

const MIME_TYPES: Partial<Record<DocumentFormat, string>> = {
  [DocumentFormat.Pdf]: 'application/pdf',
  [DocumentFormat.Docx]: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  [DocumentFormat.Txt]: 'text/plain',
};

/** Type MIME du format, ou `application/octet-stream` faute de mieux. */
export function documentMimeType(format: DocumentFormat): string {
  return MIME_TYPES[format] ?? 'application/octet-stream';
}

/**
 * Dérive un nom de fichier sûr d'un titre libre.
 *
 * La liste est BLANCHE (`[a-z0-9]` après translittération), jamais noire : une
 * liste noire laisserait passer tout ce qu'on n'a pas anticipé — séparateurs
 * exotiques, RTL override, caractères de contrôle. Les accents sont décomposés
 * (NFD) puis leurs diacritiques retirés, pour que « Émilie » donne « emilie »
 * plutôt que de disparaître.
 */
export function buildDocumentFilename(title: string, format: DocumentFormat): string {
  const slug = (title ?? '')
    .normalize('NFD')
    // Diacritiques Unicode combinants : classe explicite plutôt que `\p{M}`, les
    // classes Unicode étant proscrites ailleurs dans le projet (Zod 3.25.76).
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_BASENAME_LENGTH)
    // La troncature peut recréer un tiret terminal.
    .replace(/-+$/g, '');

  const basename = slug.length > 0 ? slug : FALLBACK_DOCUMENT_BASENAME;

  // La valeur de l'enum EST l'extension attendue (`pdf`, `docx`, `txt`…).
  return `${basename}.${format}`;
}

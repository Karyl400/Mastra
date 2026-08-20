import { DocumentFormat } from '../../../../shared/types';

export const FALLBACK_DOCUMENT_BASENAME = 'document';

const MAX_BASENAME_LENGTH = 80;

const MIME_TYPES: Partial<Record<DocumentFormat, string>> = {
  [DocumentFormat.Pdf]: 'application/pdf',
  [DocumentFormat.Docx]: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  [DocumentFormat.Txt]: 'text/plain',
};

export function documentMimeType(format: DocumentFormat): string {
  return MIME_TYPES[format] ?? 'application/octet-stream';
}

export function buildDocumentFilename(title: string, format: DocumentFormat): string {
  const slug = (title ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    // eslint-disable-next-line sonarjs/super-linear-regex
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_BASENAME_LENGTH)
    // eslint-disable-next-line sonarjs/super-linear-regex
    .replace(/-+$/g, '');

  const basename = slug.length > 0 ? slug : FALLBACK_DOCUMENT_BASENAME;

  return `${basename}.${format}`;
}

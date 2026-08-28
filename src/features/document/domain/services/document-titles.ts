import { DocumentType } from '../../../../shared/types';
import type { DocumentRenderInput } from '../ports/document-renderer';

export const DEFAULT_TITLES: Record<DocumentType, string> = {
  [DocumentType.Contract]: 'Contrat de travail',
  [DocumentType.Amendment]: 'Avenant au contrat',
  [DocumentType.WelcomeLetter]: 'Lettre de bienvenue',
  [DocumentType.Guide]: 'Guide d’onboarding',
  [DocumentType.Certificate]: 'Certificat d’onboarding',
  [DocumentType.Policy]: 'Politique interne',
  [DocumentType.TaxForm]: 'Document fiscal',
  [DocumentType.IDDocument]: 'Pièce d’identité',
  [DocumentType.Other]: 'Document',
};

export function titleOf(input: DocumentRenderInput): string {
  const provided = (input.title ?? '').trim();
  return provided.length > 0 ? provided : DEFAULT_TITLES[input.type];
}

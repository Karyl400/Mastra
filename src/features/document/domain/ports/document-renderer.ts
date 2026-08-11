import type { DocumentFormat, DocumentType } from '../../../../shared/types';

/**
 * Rendu binaire d'un document.
 *
 * `Uint8Array` et non `Buffer` : `Buffer` est un type Node, et la couche `domain`
 * doit rester du TypeScript pur (garde-fou `tests/unit/quality/architecture.test.ts`).
 * Les implémentations rendent en pratique un `Buffer`, qui EST un `Uint8Array` —
 * la contrainte ne coûte donc rien au runtime et garde le port transportable.
 */
export interface RenderedDocument {
  bytes: Uint8Array;
  /** Nom sûr, déjà assaini : il part chez Slack et en pièce jointe email. */
  filename: string;
  mimeType: string;
}

export interface DocumentRenderInput {
  type: DocumentType;
  title: string;
  /** Corps libre rédigé par l'agent — potentiellement multi-paragraphes. */
  content: string;
  employee?: {
    firstName?: string;
    lastName?: string;
    email?: string;
    department?: string;
    position?: string;
    startDate?: string;
  };
}

/**
 * Un renderer par format. Le choix du format se fait en sélectionnant
 * l'implémentation, jamais en passant un drapeau : ainsi le contenu produit est
 * gouverné par un seul et même modèle logique (voir `domain/services/document-template.ts`).
 */
export interface DocumentRenderer {
  readonly format: DocumentFormat;
  render(input: DocumentRenderInput): Promise<RenderedDocument>;
}

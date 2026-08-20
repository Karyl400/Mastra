import type { DocumentFormat, DocumentType } from '../../../../shared/types';

export interface RenderedDocument {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
}

export interface DocumentRenderInput {
  type: DocumentType;
  title: string;
  content: string;
  employee?: {
    firstName?: string;
    lastName?: string;
    email?: string;
    position?: string;
    startDate?: string;
  };
  interview?: {
    dailyWork?: string;
    workStyle?: string;
    channels?: readonly string[];
  };
}

export interface DocumentRenderer {
  readonly format: DocumentFormat;
  render(input: DocumentRenderInput): Promise<RenderedDocument>;
}

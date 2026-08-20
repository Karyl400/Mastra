import {
  DocumentFormat,
  DocumentStatus,
  DocumentType,
  type Timestamps,
} from '../../../../shared/types';

export interface Document extends Timestamps {
  readonly id: string;
  readonly employeeId: string;
  readonly type: DocumentType;
  readonly title: string;
  readonly content: string;
  readonly format: DocumentFormat;
  readonly status: DocumentStatus;
  readonly generatedAt?: string | null;
}

export function createDocument(data: Omit<Document, keyof Timestamps | 'status'>): Document {
  const now = new Date().toISOString();
  return {
    ...data,
    status: DocumentStatus.Pending,
    createdAt: now,
    updatedAt: now,
  };
}

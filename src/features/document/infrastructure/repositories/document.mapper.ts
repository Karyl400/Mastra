import type { documents } from '../../../../infrastructure/database/schema';
import type { Document } from '../../domain/entities/document';
import type { DocumentFormat, DocumentStatus, DocumentType } from '../../../../shared/types';

type DocumentRow = typeof documents.$inferSelect;
type DocumentInsert = typeof documents.$inferInsert;

export function toPersistenceDocument(doc: Document): DocumentInsert {
  return {
    id: doc.id,
    employeeId: doc.employeeId,
    type: doc.type,
    title: doc.title,
    content: doc.content,
    format: doc.format,
    status: doc.status,
    generatedAt: doc.generatedAt ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export function toDomainDocument(row: DocumentRow): Document {
  return {
    id: row.id,
    employeeId: row.employeeId,
    type: row.type as DocumentType,
    title: row.title,
    content: row.content ?? '',
    format: row.format as DocumentFormat,
    status: row.status as DocumentStatus,
    generatedAt: row.generatedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

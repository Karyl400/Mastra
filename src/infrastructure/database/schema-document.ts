import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
  index,
  foreignKey,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import { employees } from './schema-employee';

export const documents = sqliteTable(
  'documents',
  {
    id: text('id').primaryKey(),
    employeeId: text('employee_id').notNull(),
    templateId: text('template_id'),

    type: text('type').notNull(),
    title: text('title').notNull(),
    description: text('description').default(''),

    content: text('content'),

    storageKey: text('storage_key'),
    storageBucket: text('storage_bucket'),
    fileName: text('file_name'),
    fileSize: integer('file_size'),
    mimeType: text('mime_type'),

    format: text('format').notNull(),
    status: text('status').notNull().default('pending'),

    version: integer('version').notNull().default(1),
    isConfidential: integer('is_confidential', { mode: 'boolean' }).default(false),
    expiresAt: text('expires_at'),

    generatedAt: text('generated_at'),
    signedAt: text('signed_at'),
    viewedAt: text('viewed_at'),

    metadata: text('metadata', { mode: 'json' }),

    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    deletedAt: text('deleted_at'),
  },
  (table) => ({
    employeeFk: foreignKey(() => ({
      columns: [table.employeeId],
      foreignColumns: [employees.id],
      name: 'fk_documents_employee',
    })),

    employeeIdx: index('idx_documents_employee').on(table.employeeId),
    typeIdx: index('idx_documents_type').on(table.type),
    statusIdx: index('idx_documents_status').on(table.status),
    formatIdx: index('idx_documents_format').on(table.format),
    storageKeyIdx: uniqueIndex('idx_documents_storage_key').on(table.storageKey),
    expiresAtIdx: index('idx_documents_expires_at').on(table.expiresAt),
    deletedAtIdx: index('idx_documents_deleted_at').on(table.deletedAt),
  }),
);

export const employeeDocuments = sqliteTable(
  'employee_documents',
  {
    id: text('id').primaryKey(),
    employeeId: text('employee_id').notNull(),
    documentId: text('document_id').notNull(),

    status: text('status').notNull().default('pending'),
    acknowledgedAt: text('acknowledged_at'),
    signedAt: text('signed_at'),

    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    employeeFk: foreignKey(() => ({
      columns: [table.employeeId],
      foreignColumns: [employees.id],
      name: 'fk_employee_documents_employee',
    })),
    documentFk: foreignKey(() => ({
      columns: [table.documentId],
      foreignColumns: [documents.id],
      name: 'fk_employee_documents_document',
    })),

    uniqueEmployeeDocument: uniqueIndex('uq_employee_document').on(
      table.employeeId,
      table.documentId,
    ),

    employeeIdx: index('idx_employee_documents_employee').on(table.employeeId),
    documentIdx: index('idx_employee_documents_document').on(table.documentId),
    statusIdx: index('idx_employee_documents_status').on(table.status),
  }),
);

export type Document = InferSelectModel<typeof documents>;
export type EmployeeDocument = InferSelectModel<typeof employeeDocuments>;

export type NewDocument = InferInsertModel<typeof documents>;
export type NewEmployeeDocument = InferInsertModel<typeof employeeDocuments>;

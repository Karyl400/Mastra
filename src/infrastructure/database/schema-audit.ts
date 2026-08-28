import { sqliteTable, text, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    action: text('action').notNull(),
    actorId: text('actor_id').notNull(),
    actorType: text('actor_type').notNull().default('user'),
    actorEmail: text('actor_email'),

    resourceId: text('resource_id'),
    resourceType: text('resource_type'),

    details: text('details', { mode: 'json' }),

    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    requestId: text('request_id'),
    correlationId: text('correlation_id'),
    sessionId: text('session_id'),

    status: text('status').notNull().default('success'),
    errorMessage: text('error_message'),

    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    actorIdx: index('idx_audit_logs_actor').on(table.actorId, table.actorType),
    resourceIdx: index('idx_audit_logs_resource').on(table.resourceType, table.resourceId),
    actionIdx: index('idx_audit_logs_action').on(table.action),
    statusIdx: index('idx_audit_logs_status').on(table.status),
    createdAtIdx: index('idx_audit_logs_created_at').on(table.createdAt),
    requestIdIdx: index('idx_audit_logs_request_id').on(table.requestId),
    sessionIdIdx: index('idx_audit_logs_session_id').on(table.sessionId),
  }),
);

export type AuditLog = InferSelectModel<typeof auditLogs>;

export type NewAuditLog = InferInsertModel<typeof auditLogs>;

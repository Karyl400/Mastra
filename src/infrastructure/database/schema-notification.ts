import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';

export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    recipientId: text('recipient_id').notNull(),
    recipientType: text('recipient_type').notNull(),
    channel: text('channel').notNull(),
    priority: text('priority').notNull().default('normal'),

    templateId: text('template_id'),
    templateData: text('template_data', { mode: 'json' }),

    subject: text('subject').notNull(),
    body: text('body').notNull(),

    status: text('status').notNull().default('pending'),
    errorMessage: text('error_message'),
    retryCount: integer('retry_count').notNull().default(0),

    scheduledAt: text('scheduled_at'),
    sentAt: text('sent_at'),
    deliveredAt: text('delivered_at'),
    readAt: text('read_at'),

    metadata: text('metadata', { mode: 'json' }),

    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    recipientIdx: index('idx_notifications_recipient').on(table.recipientId, table.recipientType),
    statusIdx: index('idx_notifications_status').on(table.status),
    channelIdx: index('idx_notifications_channel').on(table.channel),
    scheduledAtIdx: index('idx_notifications_scheduled_at').on(table.scheduledAt),
    sentAtIdx: index('idx_notifications_sent_at').on(table.sentAt),
    createdAtIdx: index('idx_notifications_created_at').on(table.createdAt),
  }),
);

export type Notification = InferSelectModel<typeof notifications>;

export type NewNotification = InferInsertModel<typeof notifications>;

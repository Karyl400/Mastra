import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';

export const rateLimitCounters = sqliteTable(
  'rate_limit_counters',
  {
    key: text('key').primaryKey(),

    count: integer('count').notNull(),

    windowStart: integer('window_start', { mode: 'timestamp_ms' }).notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({
    expiresAtIdx: index('idx_rate_limit_counters_expires_at').on(table.expiresAt),
  }),
);

export type RateLimitCounterRow = InferSelectModel<typeof rateLimitCounters>;

export type NewRateLimitCounterRow = InferInsertModel<typeof rateLimitCounters>;

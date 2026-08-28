import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';

export const conversationTurns = sqliteTable(
  'conversation_turns',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id').notNull(),
    role: text('role').notNull(),
    content: text('content').notNull(),
    agentId: text('agent_id').notNull(),
    slackUserId: text('slack_user_id'),

    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({
    conversationCreatedAtIdx: index('idx_conversation_turns_conversation_created_at').on(
      table.conversationId,
      table.createdAt,
    ),
    createdAtIdx: index('idx_conversation_turns_created_at').on(table.createdAt),
  }),
);

export const pinnedFacts = sqliteTable(
  'pinned_facts',
  {
    id: text('id').primaryKey(),
    slackUserId: text('slack_user_id').notNull(),
    fact: text('fact').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({
    userCreatedAtIdx: index('idx_pinned_facts_user_created_at').on(
      table.slackUserId,
      table.createdAt,
    ),
  }),
);

export type ConversationTurnRow = InferSelectModel<typeof conversationTurns>;

export type NewConversationTurnRow = InferInsertModel<typeof conversationTurns>;

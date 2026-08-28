import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

export const channelMessages = sqliteTable(
  'channel_messages',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id').notNull(),
    slackUserId: text('slack_user_id'),
    text: text('text').notNull(),
    threadTs: text('thread_ts'),
    postedAt: integer('posted_at').notNull(),
    createdAt: integer('created_at').notNull(),
    distilledAt: integer('distilled_at'),
  },
  (table) => ({
    channelIdx: index('idx_channel_messages_channel').on(table.channelId, table.postedAt),
    pendingIdx: index('idx_channel_messages_pending').on(table.distilledAt, table.postedAt),
    userIdx: index('idx_channel_messages_user').on(table.slackUserId, table.postedAt),
    createdIdx: index('idx_channel_messages_created').on(table.createdAt),
  }),
);

export const knowledgeFacts = sqliteTable(
  'knowledge_facts',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id').notNull(),
    slackUserId: text('slack_user_id'),
    kind: text('kind').notNull(),
    summary: text('summary').notNull(),
    score: integer('score').notNull(),
    postedAt: integer('posted_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => ({
    channelIdx: index('idx_knowledge_facts_channel').on(table.channelId, table.postedAt),
    userIdx: index('idx_knowledge_facts_user').on(table.slackUserId, table.postedAt),
    scoreIdx: index('idx_knowledge_facts_score').on(table.score, table.postedAt),
  }),
);

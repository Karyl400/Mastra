import { sqliteTable, text, integer, index, primaryKey } from 'drizzle-orm/sqlite-core';
import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import { employees } from './schema-employee';

export const slackEventDedup = sqliteTable(
  'slack_event_dedup',
  {
    key: text('key').primaryKey(),
    status: text('status').notNull(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({
    startedAtIdx: index('idx_slack_event_dedup_started_at').on(table.startedAt),
  }),
);

export const slackDirectory = sqliteTable(
  'slack_directory',
  {
    slackUserId: text('slack_user_id').primaryKey(),
    teamId: text('team_id').notNull(),

    email: text('email'),

    realName: text('real_name').notNull().default(''),
    displayName: text('display_name').notNull().default(''),

    firstName: text('first_name'),
    lastName: text('last_name'),
    title: text('title'),

    isBot: integer('is_bot', { mode: 'boolean' }).notNull().default(false),
    isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
    isRestricted: integer('is_restricted', { mode: 'boolean' }).notNull().default(false),
    isUltraRestricted: integer('is_ultra_restricted', { mode: 'boolean' }).notNull().default(false),
    isDeleted: integer('is_deleted', { mode: 'boolean' }).notNull().default(false),

    dmChannelId: text('dm_channel_id'),

    employeeId: text('employee_id').references(() => employees.id),

    role: text('role').notNull().default('employee'),

    firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull(),
    syncedAt: integer('synced_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({
    emailIdx: index('idx_slack_directory_email').on(table.email),
    employeeIdIdx: index('idx_slack_directory_employee_id').on(table.employeeId),
    syncedAtIdx: index('idx_slack_directory_synced_at').on(table.syncedAt),
  }),
);

export const slackChannels = sqliteTable(
  'slack_channels',
  {
    channelId: text('channel_id').primaryKey(),

    name: text('name').notNull().default(''),

    isPrivate: integer('is_private', { mode: 'boolean' }).notNull().default(false),
    isArchived: integer('is_archived', { mode: 'boolean' }).notNull().default(false),
    isMember: integer('is_member', { mode: 'boolean' }).notNull().default(false),

    memberCountReported: integer('member_count_reported'),

    syncedAt: integer('synced_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({
    syncedAtIdx: index('idx_slack_channels_synced_at').on(table.syncedAt),
  }),
);

export const slackChannelMembers = sqliteTable(
  'slack_channel_members',
  {
    channelId: text('channel_id')
      .notNull()
      .references(() => slackChannels.channelId),

    slackUserId: text('slack_user_id').notNull(),

    firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull(),

    syncedAt: integer('synced_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.channelId, table.slackUserId] }),

    userIdx: index('idx_slack_channel_members_user').on(table.slackUserId),

    syncedAtIdx: index('idx_slack_channel_members_synced_at').on(table.syncedAt),
  }),
);

export type SlackEventDedupRow = InferSelectModel<typeof slackEventDedup>;
export type SlackDirectoryRow = InferSelectModel<typeof slackDirectory>;
export type SlackChannelRow = InferSelectModel<typeof slackChannels>;
export type SlackChannelMemberRow = InferSelectModel<typeof slackChannelMembers>;

export type NewSlackEventDedupRow = InferInsertModel<typeof slackEventDedup>;
export type NewSlackDirectoryRow = InferInsertModel<typeof slackDirectory>;
export type NewSlackChannelRow = InferInsertModel<typeof slackChannels>;
export type NewSlackChannelMemberRow = InferInsertModel<typeof slackChannelMembers>;

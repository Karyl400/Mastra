import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const pendingInterviewEmail = sqliteTable('pending_interview_email', {
  conversationId: text('conversation_id').primaryKey(),
  requesterUserId: text('requester_user_id').notNull(),
  to: text('to_email').notNull(),
  candidateName: text('candidate_name'),
  startsAt: text('starts_at').notNull(),
  position: text('position'),
  location: text('location'),
  replyTo: text('reply_to'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export type PendingInterviewEmailRow = typeof pendingInterviewEmail.$inferSelect;

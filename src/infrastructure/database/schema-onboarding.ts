import {
  sqliteTable,
  text,
  integer,
  real,
  uniqueIndex,
  index,
  foreignKey,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import { employees, tasks } from './schema-employee';

export const onboardingProgress = sqliteTable(
  'onboarding_progress',
  {
    id: text('id').primaryKey(),
    employeeId: text('employee_id').notNull(),
    templateId: text('template_id'),

    status: text('status').notNull().default('not_started'),
    currentStep: integer('current_step').notNull().default(0),
    totalSteps: integer('total_steps').notNull(),
    completionPercentage: real('completion_percentage').default(0),

    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    blockedAt: text('blocked_at'),
    blockReason: text('block_reason'),

    assignedBuddyId: text('assigned_buddy_id'),

    metadata: text('metadata', { mode: 'json' }),

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
      name: 'fk_onboarding_progress_employee',
    })),
    buddyFk: foreignKey(() => ({
      columns: [table.assignedBuddyId],
      foreignColumns: [employees.id],
      name: 'fk_onboarding_progress_buddy',
    })),

    uniqueEmployee: uniqueIndex('uq_onboarding_employee').on(table.employeeId),

    statusIdx: index('idx_onboarding_progress_status').on(table.status),
    completionIdx: index('idx_onboarding_progress_completion').on(table.completionPercentage),
  }),
);

export const onboardingSteps = sqliteTable(
  'onboarding_steps',
  {
    id: text('id').primaryKey(),
    progressId: text('progress_id').notNull(),
    taskId: text('task_id'),

    name: text('name').notNull(),
    description: text('description').default(''),
    stepOrder: integer('step_order').notNull(),
    category: text('category'),

    status: text('status').notNull().default('pending'),
    isRequired: integer('is_required', { mode: 'boolean' }).notNull().default(true),

    assignedTo: text('assigned_to'),

    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    dueDate: text('due_date'),

    notes: text('notes'),

    metadata: text('metadata', { mode: 'json' }),

    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    progressFk: foreignKey(() => ({
      columns: [table.progressId],
      foreignColumns: [onboardingProgress.id],
      name: 'fk_onboarding_steps_progress',
    })),
    taskFk: foreignKey(() => ({
      columns: [table.taskId],
      foreignColumns: [tasks.id],
      name: 'fk_onboarding_steps_task',
    })),

    progressIdx: index('idx_onboarding_steps_progress').on(table.progressId),
    statusIdx: index('idx_onboarding_steps_status').on(table.status),
    orderIdx: index('idx_onboarding_steps_order').on(table.progressId, table.stepOrder),
    dueDateIdx: index('idx_onboarding_steps_due_date').on(table.dueDate),
  }),
);

export const onboardingInterview = sqliteTable(
  'onboarding_interview',
  {
    employeeId: text('employee_id').primaryKey(),
    slackUserId: text('slack_user_id').notNull(),
    channels: text('channels', { mode: 'json' }).notNull(),
    dailyWork: text('daily_work').notNull().default(''),
    workStyle: text('work_style').notNull().default(''),

    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({
    slackUserIdx: index('idx_onboarding_interview_slack_user').on(table.slackUserId),
  }),
);

export type OnboardingProgress = InferSelectModel<typeof onboardingProgress>;
export type OnboardingStep = InferSelectModel<typeof onboardingSteps>;

export type NewOnboardingProgress = InferInsertModel<typeof onboardingProgress>;
export type NewOnboardingStep = InferInsertModel<typeof onboardingSteps>;

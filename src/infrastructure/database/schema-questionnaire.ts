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
import { employees } from './schema-employee';

export const questionnaires = sqliteTable(
  'questionnaires',
  {
    id: text('id').primaryKey(),
    employeeId: text('employee_id'),

    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    category: text('category'),

    questions: text('questions', { mode: 'json' }).notNull(),

    status: text('status').notNull().default('draft'),
    isAnonymous: integer('is_anonymous', { mode: 'boolean' }).default(false),

    assignedBy: text('assigned_by'),
    dueDate: text('due_date'),

    version: integer('version').notNull().default(1),

    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    publishedAt: text('published_at'),
    closedAt: text('closed_at'),
    deletedAt: text('deleted_at'),
  },
  (table) => ({
    employeeFk: foreignKey(() => ({
      columns: [table.employeeId],
      foreignColumns: [employees.id],
      name: 'fk_questionnaires_employee',
    })),

    employeeIdx: index('idx_questionnaires_employee').on(table.employeeId),
    statusIdx: index('idx_questionnaires_status').on(table.status),
    categoryIdx: index('idx_questionnaires_category').on(table.category),
    dueDateIdx: index('idx_questionnaires_due_date').on(table.dueDate),
    deletedAtIdx: index('idx_questionnaires_deleted_at').on(table.deletedAt),
  }),
);

export const questionnaireResponses = sqliteTable(
  'questionnaire_responses',
  {
    id: text('id').primaryKey(),
    questionnaireId: text('questionnaire_id').notNull(),
    employeeId: text('employee_id').notNull(),

    answers: text('answers', { mode: 'json' }).notNull(),

    status: text('status').notNull().default('pending'),
    score: real('score'),
    maxScore: real('max_score'),
    percentage: real('percentage'),

    timeSpentSeconds: integer('time_spent_seconds'),

    reviewedBy: text('reviewed_by'),
    reviewedAt: text('reviewed_at'),
    reviewNotes: text('review_notes'),

    submittedAt: text('submitted_at'),

    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    questionnaireFk: foreignKey(() => ({
      columns: [table.questionnaireId],
      foreignColumns: [questionnaires.id],
      name: 'fk_responses_questionnaire',
    })),
    employeeFk: foreignKey(() => ({
      columns: [table.employeeId],
      foreignColumns: [employees.id],
      name: 'fk_responses_employee',
    })),
    reviewerFk: foreignKey(() => ({
      columns: [table.reviewedBy],
      foreignColumns: [employees.id],
      name: 'fk_responses_reviewer',
    })),

    uniqueEmployeeQuestionnaire: uniqueIndex('uq_responses_employee_questionnaire').on(
      table.employeeId,
      table.questionnaireId,
    ),

    questionnaireIdx: index('idx_responses_questionnaire').on(table.questionnaireId),
    employeeIdx: index('idx_responses_employee').on(table.employeeId),
    statusIdx: index('idx_responses_status').on(table.status),
    submittedAtIdx: index('idx_responses_submitted_at').on(table.submittedAt),
  }),
);

export type Questionnaire = InferSelectModel<typeof questionnaires>;
export type QuestionnaireResponse = InferSelectModel<typeof questionnaireResponses>;

export type NewQuestionnaire = InferInsertModel<typeof questionnaires>;
export type NewQuestionnaireResponse = InferInsertModel<typeof questionnaireResponses>;

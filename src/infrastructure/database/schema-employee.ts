import {
  sqliteTable,
  text,
  real,
  uniqueIndex,
  index,
  foreignKey,
  check,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';

export const employees = sqliteTable(
  'employees',
  {
    id: text('id').primaryKey(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    email: text('email').notNull().unique(),
    phone: text('phone'),
    department: text('department'),
    position: text('position').notNull(),
    startDate: text('start_date').notNull(),
    status: text('status').notNull().default('pending'),
    onboardingStatus: text('onboarding_status').notNull().default('not_started'),
    managerId: text('manager_id'),
    emergencyContactName: text('emergency_contact_name'),
    emergencyContactPhone: text('emergency_contact_phone'),
    emergencyContactRelationship: text('emergency_contact_relationship'),
    salaryAmount: real('salary_amount'),
    salaryCurrency: text('salary_currency').default('EUR'),
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
    emailIdx: uniqueIndex('idx_employees_email').on(table.email),
    statusIdx: index('idx_employees_status').on(table.status),
    managerIdx: index('idx_employees_manager').on(table.managerId),
    onboardingStatusIdx: index('idx_employees_onboarding_status').on(table.onboardingStatus),
    startDateIdx: index('idx_employees_start_date').on(table.startDate),
    deletedAtIdx: index('idx_employees_deleted_at').on(table.deletedAt),
    nameSearchIdx: index('idx_employees_name_search').on(table.firstName, table.lastName),

    emailCheck: check('chk_employees_email', sql`${table.email} LIKE '%@%'`),
  }),
);

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    employeeId: text('employee_id').notNull(),
    assigneeId: text('assignee_id'),
    reviewerId: text('reviewer_id'),

    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    type: text('type').notNull(),
    status: text('status').notNull().default('pending'),
    priority: text('priority').notNull().default('medium'),

    dueDate: text('due_date'),
    completedAt: text('completed_at'),
    startedAt: text('started_at'),

    estimatedHours: real('estimated_hours'),
    actualHours: real('actual_hours'),

    tags: text('tags', { mode: 'json' }).default('[]'),
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
      name: 'fk_tasks_employee',
    })),
    assigneeFk: foreignKey(() => ({
      columns: [table.assigneeId],
      foreignColumns: [employees.id],
      name: 'fk_tasks_assignee',
    })),
    reviewerFk: foreignKey(() => ({
      columns: [table.reviewerId],
      foreignColumns: [employees.id],
      name: 'fk_tasks_reviewer',
    })),

    employeeIdx: index('idx_tasks_employee').on(table.employeeId),
    assigneeIdx: index('idx_tasks_assignee').on(table.assigneeId),
    statusIdx: index('idx_tasks_status').on(table.status),
    typeIdx: index('idx_tasks_type').on(table.type),
    priorityIdx: index('idx_tasks_priority').on(table.priority),
    dueDateIdx: index('idx_tasks_due_date').on(table.dueDate),
    completedAtIdx: index('idx_tasks_completed_at').on(table.completedAt),
    employeeStatusIdx: index('idx_tasks_employee_status').on(table.employeeId, table.status),
    deletedAtIdx: index('idx_tasks_deleted_at').on(table.deletedAt),
  }),
);

export type Employee = InferSelectModel<typeof employees>;
export type Task = InferSelectModel<typeof tasks>;

export type NewEmployee = InferInsertModel<typeof employees>;
export type NewTask = InferInsertModel<typeof tasks>;

import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const employees = sqliteTable('employees', {
  id: text('id').primaryKey(),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  email: text('email').notNull().unique(),
  department: text('department').notNull(),
  position: text('position').notNull(),
  startDate: text('start_date').notNull(),
  status: text('status').notNull(), // EmployeeStatus
  managerId: text('manager_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  employeeId: text('employee_id').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  type: text('type').notNull(), // TaskType
  status: text('status').notNull(), // TaskStatus
  dueDate: text('due_date'),
  assignedTo: text('assigned_to'),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const documents = sqliteTable('documents', {
  id: text('id').primaryKey(),
  employeeId: text('employee_id').notNull(),
  type: text('type').notNull(), // DocumentType
  title: text('title').notNull(),
  content: text('content').notNull(),
  format: text('format').notNull(), // DocumentFormat
  status: text('status').notNull(), // DocumentStatus
  generatedAt: text('generated_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey(),
  recipientId: text('recipient_id').notNull(),
  recipientType: text('recipient_type').notNull(), // RecipientType
  channel: text('channel').notNull(), // NotificationChannel
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  status: text('status').notNull(), // NotificationStatus
  scheduledAt: text('scheduled_at'),
  sentAt: text('sent_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const questionnaires = sqliteTable('questionnaires', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  questions: text('questions', { mode: 'json' }).notNull(), // Question[]
  status: text('status').notNull(), // QuestionnaireStatus
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const questionnaireResponses = sqliteTable('questionnaire_responses', {
  id: text('id').primaryKey(),
  questionnaireId: text('questionnaire_id').notNull(),
  employeeId: text('employee_id').notNull(),
  answers: text('answers', { mode: 'json' }).notNull(), // Record<string, unknown>
  status: text('status').notNull(), // ResponseStatus
  score: real('score'),
  reviewedBy: text('reviewed_by'),
  submittedAt: text('submitted_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const onboardingProgress = sqliteTable('onboarding_progress', {
  id: text('id').primaryKey(),
  employeeId: text('employee_id').notNull(),
  status: text('status').notNull(), // OnboardingStatus
  currentStep: integer('current_step').notNull(),
  totalSteps: integer('total_steps').notNull(),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const onboardingSteps = sqliteTable('onboarding_steps', {
  id: text('id').primaryKey(),
  progressId: text('progress_id').notNull(),
  taskId: text('task_id').notNull(),
  stepOrder: integer('step_order').notNull(),
  status: text('status').notNull(), // TaskStatus
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

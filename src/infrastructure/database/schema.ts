import {
  sqliteTable,
  text,
  integer,
  real,
  uniqueIndex,
  index,
  foreignKey,
  primaryKey,
  check,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

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

export const documents = sqliteTable(
  'documents',
  {
    id: text('id').primaryKey(),
    employeeId: text('employee_id').notNull(),
    templateId: text('template_id'),

    type: text('type').notNull(),
    title: text('title').notNull(),
    description: text('description').default(''),

    content: text('content'),

    storageKey: text('storage_key'),
    storageBucket: text('storage_bucket'),
    fileName: text('file_name'),
    fileSize: integer('file_size'),
    mimeType: text('mime_type'),

    format: text('format').notNull(),
    status: text('status').notNull().default('pending'),

    version: integer('version').notNull().default(1),
    isConfidential: integer('is_confidential', { mode: 'boolean' }).default(false),
    expiresAt: text('expires_at'),

    generatedAt: text('generated_at'),
    signedAt: text('signed_at'),
    viewedAt: text('viewed_at'),

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
      name: 'fk_documents_employee',
    })),

    employeeIdx: index('idx_documents_employee').on(table.employeeId),
    typeIdx: index('idx_documents_type').on(table.type),
    statusIdx: index('idx_documents_status').on(table.status),
    formatIdx: index('idx_documents_format').on(table.format),
    storageKeyIdx: uniqueIndex('idx_documents_storage_key').on(table.storageKey),
    expiresAtIdx: index('idx_documents_expires_at').on(table.expiresAt),
    deletedAtIdx: index('idx_documents_deleted_at').on(table.deletedAt),
  }),
);

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

export const employeeDocuments = sqliteTable(
  'employee_documents',
  {
    id: text('id').primaryKey(),
    employeeId: text('employee_id').notNull(),
    documentId: text('document_id').notNull(),

    status: text('status').notNull().default('pending'),
    acknowledgedAt: text('acknowledged_at'),
    signedAt: text('signed_at'),

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
      name: 'fk_employee_documents_employee',
    })),
    documentFk: foreignKey(() => ({
      columns: [table.documentId],
      foreignColumns: [documents.id],
      name: 'fk_employee_documents_document',
    })),

    uniqueEmployeeDocument: uniqueIndex('uq_employee_document').on(
      table.employeeId,
      table.documentId,
    ),

    employeeIdx: index('idx_employee_documents_employee').on(table.employeeId),
    documentIdx: index('idx_employee_documents_document').on(table.documentId),
    statusIdx: index('idx_employee_documents_status').on(table.status),
  }),
);

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    action: text('action').notNull(),
    actorId: text('actor_id').notNull(),
    actorType: text('actor_type').notNull().default('user'),
    actorEmail: text('actor_email'),

    resourceId: text('resource_id'),
    resourceType: text('resource_type'),

    details: text('details', { mode: 'json' }),

    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    requestId: text('request_id'),
    correlationId: text('correlation_id'),
    sessionId: text('session_id'),

    status: text('status').notNull().default('success'),
    errorMessage: text('error_message'),

    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    actorIdx: index('idx_audit_logs_actor').on(table.actorId, table.actorType),
    resourceIdx: index('idx_audit_logs_resource').on(table.resourceType, table.resourceId),
    actionIdx: index('idx_audit_logs_action').on(table.action),
    statusIdx: index('idx_audit_logs_status').on(table.status),
    createdAtIdx: index('idx_audit_logs_created_at').on(table.createdAt),
    requestIdIdx: index('idx_audit_logs_request_id').on(table.requestId),
    sessionIdIdx: index('idx_audit_logs_session_id').on(table.sessionId),
  }),
);

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

import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';

export type Employee = InferSelectModel<typeof employees>;
export type Task = InferSelectModel<typeof tasks>;
export type Document = InferSelectModel<typeof documents>;
export type Notification = InferSelectModel<typeof notifications>;
export type Questionnaire = InferSelectModel<typeof questionnaires>;
export type QuestionnaireResponse = InferSelectModel<typeof questionnaireResponses>;
export type OnboardingProgress = InferSelectModel<typeof onboardingProgress>;
export type OnboardingStep = InferSelectModel<typeof onboardingSteps>;
export type EmployeeDocument = InferSelectModel<typeof employeeDocuments>;
export type AuditLog = InferSelectModel<typeof auditLogs>;
export type ConversationTurnRow = InferSelectModel<typeof conversationTurns>;
export type SlackEventDedupRow = InferSelectModel<typeof slackEventDedup>;
export type SlackDirectoryRow = InferSelectModel<typeof slackDirectory>;
export type RateLimitCounterRow = InferSelectModel<typeof rateLimitCounters>;
export type SlackChannelRow = InferSelectModel<typeof slackChannels>;
export type SlackChannelMemberRow = InferSelectModel<typeof slackChannelMembers>;

export type NewEmployee = InferInsertModel<typeof employees>;
export type NewTask = InferInsertModel<typeof tasks>;
export type NewDocument = InferInsertModel<typeof documents>;
export type NewNotification = InferInsertModel<typeof notifications>;
export type NewQuestionnaire = InferInsertModel<typeof questionnaires>;
export type NewQuestionnaireResponse = InferInsertModel<typeof questionnaireResponses>;
export type NewOnboardingProgress = InferInsertModel<typeof onboardingProgress>;
export type NewOnboardingStep = InferInsertModel<typeof onboardingSteps>;
export type NewEmployeeDocument = InferInsertModel<typeof employeeDocuments>;
export type NewAuditLog = InferInsertModel<typeof auditLogs>;
export type NewConversationTurnRow = InferInsertModel<typeof conversationTurns>;
export type NewSlackEventDedupRow = InferInsertModel<typeof slackEventDedup>;
export type NewSlackDirectoryRow = InferInsertModel<typeof slackDirectory>;
export type NewRateLimitCounterRow = InferInsertModel<typeof rateLimitCounters>;
export type NewSlackChannelRow = InferInsertModel<typeof slackChannels>;
export type NewSlackChannelMemberRow = InferInsertModel<typeof slackChannelMembers>;

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

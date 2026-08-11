// ============================================
// db/schema.ts - Production-Grade Drizzle Schema
// Standards 2026: FKs, Indexes, Soft Delete, Audit Trail
// ============================================

import {
  sqliteTable,
  text,
  integer,
  real,
  uniqueIndex,
  index,
  foreignKey,
  check,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// ============================================
// 1. EMPLOYEES
// ============================================

export const employees = sqliteTable(
  'employees',
  {
    id: text('id').primaryKey(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    email: text('email').notNull().unique(),
    phone: text('phone'),
    department: text('department').notNull(),
    position: text('position').notNull(),
    startDate: text('start_date').notNull(),
    status: text('status').notNull().default('pending'), // EmployeeStatus
    onboardingStatus: text('onboarding_status').notNull().default('not_started'), // OnboardingStatus
    managerId: text('manager_id'),
    emergencyContactName: text('emergency_contact_name'),
    emergencyContactPhone: text('emergency_contact_phone'),
    emergencyContactRelationship: text('emergency_contact_relationship'),
    salaryAmount: real('salary_amount'),
    salaryCurrency: text('salary_currency').default('EUR'),
    metadata: text('metadata', { mode: 'json' }), // Record<string, unknown>

    // Timestamps
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    deletedAt: text('deleted_at'), // Soft delete
  },
  (table) => ({
    // Indexes
    emailIdx: uniqueIndex('idx_employees_email').on(table.email),
    statusIdx: index('idx_employees_status').on(table.status),
    departmentIdx: index('idx_employees_department').on(table.department),
    managerIdx: index('idx_employees_manager').on(table.managerId),
    onboardingStatusIdx: index('idx_employees_onboarding_status').on(table.onboardingStatus),
    startDateIdx: index('idx_employees_start_date').on(table.startDate),
    deletedAtIdx: index('idx_employees_deleted_at').on(table.deletedAt),
    nameSearchIdx: index('idx_employees_name_search').on(table.firstName, table.lastName),

    // Contrainte: email doit contenir '@'
    emailCheck: check('chk_employees_email', sql`${table.email} LIKE '%@%'`),
  }),
);

// ============================================
// 2. TASKS
// ============================================

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    employeeId: text('employee_id').notNull(),
    assigneeId: text('assignee_id'), // La personne qui exécute (peut différer de employeeId)
    reviewerId: text('reviewer_id'), // Pour les tâches de type Review

    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    type: text('type').notNull(), // TaskType
    status: text('status').notNull().default('pending'), // TaskStatus
    priority: text('priority').notNull().default('medium'), // TaskPriority

    dueDate: text('due_date'),
    completedAt: text('completed_at'),
    startedAt: text('started_at'),

    estimatedHours: real('estimated_hours'),
    actualHours: real('actual_hours'),

    tags: text('tags', { mode: 'json' }).default('[]'), // string[]
    metadata: text('metadata', { mode: 'json' }), // Record<string, unknown>

    // Timestamps
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    deletedAt: text('deleted_at'), // Soft delete
  },
  (table) => ({
    // Foreign Keys
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

    // Indexes
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

// ============================================
// 3. DOCUMENTS
// ============================================

export const documents = sqliteTable(
  'documents',
  {
    id: text('id').primaryKey(),
    employeeId: text('employee_id').notNull(),
    templateId: text('template_id'), // Si généré depuis un template

    type: text('type').notNull(), // DocumentType
    title: text('title').notNull(),
    description: text('description').default(''),

    /**
     * CONTENU du document — le texte lui-même.
     *
     * Ajoutée le 2026-08-11 après une perte de données vérifiée en production :
     * l'entité `Document` déclare `content: string`, `generateDocument` l'exige
     * en entrée… et aucune colonne ne l'accueillait. Drizzle IGNORE
     * silencieusement toute clé de `.values()` sans colonne déclarée, et le
     * `as unknown as` des mappers effaçait l'écart pour le compilateur : les 6
     * documents de la Turso de production ne contiennent RIEN.
     *
     * Pourquoi une colonne, et non un mappage vers les colonnes existantes : le
     * bloc « stockage » ci-dessous décrit une référence vers un objet S3/GCS qui
     * n'existe pas — `storage_key`, `storage_bucket`, `file_name`, `file_size`
     * et `mime_type` sont NULL sur 6 lignes / 6, aucun bucket n'est configuré
     * nulle part dans le dépôt. Détourner `description` (un résumé) ou
     * `metadata` (un JSON libre) pour y loger le corps du document ferait mentir
     * deux colonnes au lieu d'en ajouter une juste. Tant qu'aucun stockage
     * objet n'existe, la base EST le stockage.
     *
     * Nullable, car les 6 lignes déjà écrites n'ont pas de contenu à rétablir.
     */
    content: text('content'),

    // Stockage : on stocke la référence S3, pas le contenu
    storageKey: text('storage_key'), // Clé S3/GCS
    storageBucket: text('storage_bucket'),
    fileName: text('file_name'),
    fileSize: integer('file_size'), // En bytes
    mimeType: text('mime_type'),

    format: text('format').notNull(), // DocumentFormat
    status: text('status').notNull().default('pending'), // DocumentStatus

    version: integer('version').notNull().default(1),
    isConfidential: integer('is_confidential', { mode: 'boolean' }).default(false),
    expiresAt: text('expires_at'),

    generatedAt: text('generated_at'),
    signedAt: text('signed_at'),
    viewedAt: text('viewed_at'),

    metadata: text('metadata', { mode: 'json' }), // Record<string, unknown>

    // Timestamps
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    deletedAt: text('deleted_at'), // Soft delete
  },
  (table) => ({
    // Foreign Keys
    employeeFk: foreignKey(() => ({
      columns: [table.employeeId],
      foreignColumns: [employees.id],
      name: 'fk_documents_employee',
    })),

    // Indexes
    employeeIdx: index('idx_documents_employee').on(table.employeeId),
    typeIdx: index('idx_documents_type').on(table.type),
    statusIdx: index('idx_documents_status').on(table.status),
    formatIdx: index('idx_documents_format').on(table.format),
    storageKeyIdx: uniqueIndex('idx_documents_storage_key').on(table.storageKey),
    expiresAtIdx: index('idx_documents_expires_at').on(table.expiresAt),
    deletedAtIdx: index('idx_documents_deleted_at').on(table.deletedAt),
  }),
);

// ============================================
// 4. NOTIFICATIONS
// ============================================

export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    recipientId: text('recipient_id').notNull(),
    recipientType: text('recipient_type').notNull(), // RecipientType
    channel: text('channel').notNull(), // NotificationChannel
    priority: text('priority').notNull().default('normal'), // NotificationPriority

    templateId: text('template_id'),
    templateData: text('template_data', { mode: 'json' }), // Record<string, unknown>

    subject: text('subject').notNull(),
    body: text('body').notNull(),

    status: text('status').notNull().default('pending'), // NotificationStatus
    errorMessage: text('error_message'),
    retryCount: integer('retry_count').notNull().default(0),

    scheduledAt: text('scheduled_at'),
    sentAt: text('sent_at'),
    deliveredAt: text('delivered_at'),
    readAt: text('read_at'),

    metadata: text('metadata', { mode: 'json' }), // Record<string, unknown>

    // Timestamps
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    // Indexes
    recipientIdx: index('idx_notifications_recipient').on(table.recipientId, table.recipientType),
    statusIdx: index('idx_notifications_status').on(table.status),
    channelIdx: index('idx_notifications_channel').on(table.channel),
    scheduledAtIdx: index('idx_notifications_scheduled_at').on(table.scheduledAt),
    sentAtIdx: index('idx_notifications_sent_at').on(table.sentAt),
    createdAtIdx: index('idx_notifications_created_at').on(table.createdAt),
  }),
);

// ============================================
// 5. QUESTIONNAIRES
// ============================================

export const questionnaires = sqliteTable(
  'questionnaires',
  {
    id: text('id').primaryKey(),
    employeeId: text('employee_id'), // Nullable: questionnaire peut être un template

    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    category: text('category'), // 'onboarding', 'feedback', 'evaluation', 'exit'

    questions: text('questions', { mode: 'json' }).notNull(), // Question[]

    status: text('status').notNull().default('draft'), // QuestionnaireStatus
    isAnonymous: integer('is_anonymous', { mode: 'boolean' }).default(false),

    assignedBy: text('assigned_by'), // Qui a assigné le questionnaire
    dueDate: text('due_date'),

    version: integer('version').notNull().default(1),

    // Timestamps
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
    // Foreign Keys
    employeeFk: foreignKey(() => ({
      columns: [table.employeeId],
      foreignColumns: [employees.id],
      name: 'fk_questionnaires_employee',
    })),

    // Indexes
    employeeIdx: index('idx_questionnaires_employee').on(table.employeeId),
    statusIdx: index('idx_questionnaires_status').on(table.status),
    categoryIdx: index('idx_questionnaires_category').on(table.category),
    dueDateIdx: index('idx_questionnaires_due_date').on(table.dueDate),
    deletedAtIdx: index('idx_questionnaires_deleted_at').on(table.deletedAt),
  }),
);

// ============================================
// 6. QUESTIONNAIRE RESPONSES
// ============================================

export const questionnaireResponses = sqliteTable(
  'questionnaire_responses',
  {
    id: text('id').primaryKey(),
    questionnaireId: text('questionnaire_id').notNull(),
    employeeId: text('employee_id').notNull(),

    answers: text('answers', { mode: 'json' }).notNull(), // QuestionResponse[]

    status: text('status').notNull().default('pending'), // ResponseStatus
    score: real('score'),
    maxScore: real('max_score'),
    percentage: real('percentage'), // 0-100

    timeSpentSeconds: integer('time_spent_seconds'),

    reviewedBy: text('reviewed_by'),
    reviewedAt: text('reviewed_at'),
    reviewNotes: text('review_notes'),

    submittedAt: text('submitted_at'),

    // Timestamps
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    // Foreign Keys
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

    // Unique: un employé ne peut répondre qu'une fois à un questionnaire
    // (sauf si le questionnaire le permet explicitement)
    uniqueEmployeeQuestionnaire: uniqueIndex('uq_responses_employee_questionnaire').on(
      table.employeeId,
      table.questionnaireId,
    ),

    // Indexes
    questionnaireIdx: index('idx_responses_questionnaire').on(table.questionnaireId),
    employeeIdx: index('idx_responses_employee').on(table.employeeId),
    statusIdx: index('idx_responses_status').on(table.status),
    submittedAtIdx: index('idx_responses_submitted_at').on(table.submittedAt),
  }),
);

// ============================================
// 7. ONBOARDING PROGRESS
// ============================================

export const onboardingProgress = sqliteTable(
  'onboarding_progress',
  {
    id: text('id').primaryKey(),
    employeeId: text('employee_id').notNull(),
    templateId: text('template_id'), // Si basé sur un template d'onboarding

    status: text('status').notNull().default('not_started'), // OnboardingStatus
    currentStep: integer('current_step').notNull().default(0),
    totalSteps: integer('total_steps').notNull(),
    completionPercentage: real('completion_percentage').default(0), // 0-100

    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    blockedAt: text('blocked_at'),
    blockReason: text('block_reason'),

    assignedBuddyId: text('assigned_buddy_id'), // Référent/parrain

    metadata: text('metadata', { mode: 'json' }), // Record<string, unknown>

    // Timestamps
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    // Foreign Keys
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

    // Unique: un seul onboarding actif par employé
    uniqueEmployee: uniqueIndex('uq_onboarding_employee').on(table.employeeId),

    // Indexes
    statusIdx: index('idx_onboarding_progress_status').on(table.status),
    completionIdx: index('idx_onboarding_progress_completion').on(table.completionPercentage),
  }),
);

// ============================================
// 8. ONBOARDING STEPS
// ============================================

export const onboardingSteps = sqliteTable(
  'onboarding_steps',
  {
    id: text('id').primaryKey(),
    progressId: text('progress_id').notNull(),
    taskId: text('task_id'), // Optionnel: lié à une tâche existante

    name: text('name').notNull(),
    description: text('description').default(''),
    stepOrder: integer('step_order').notNull(),
    category: text('category'), // 'documents', 'training', 'meetings', 'setup'

    status: text('status').notNull().default('pending'), // TaskStatus
    isRequired: integer('is_required', { mode: 'boolean' }).notNull().default(true),

    assignedTo: text('assigned_to'), // Qui est responsable de cette étape

    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    dueDate: text('due_date'),

    notes: text('notes'),

    metadata: text('metadata', { mode: 'json' }), // Record<string, unknown>

    // Timestamps
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    // Foreign Keys
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

    // Indexes
    progressIdx: index('idx_onboarding_steps_progress').on(table.progressId),
    statusIdx: index('idx_onboarding_steps_status').on(table.status),
    orderIdx: index('idx_onboarding_steps_order').on(table.progressId, table.stepOrder),
    dueDateIdx: index('idx_onboarding_steps_due_date').on(table.dueDate),
  }),
);

// ============================================
// 9. EMPLOYEE DOCUMENTS (Junction Table)
// ============================================

export const employeeDocuments = sqliteTable(
  'employee_documents',
  {
    id: text('id').primaryKey(),
    employeeId: text('employee_id').notNull(),
    documentId: text('document_id').notNull(),

    // Statut spécifique à l'association employé-document
    status: text('status').notNull().default('pending'), // 'pending', 'acknowledged', 'signed', 'expired'
    acknowledgedAt: text('acknowledged_at'),
    signedAt: text('signed_at'),

    // Timestamps
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    // Foreign Keys
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

    // Unique: un document ne peut être assigné qu'une fois à un employé
    uniqueEmployeeDocument: uniqueIndex('uq_employee_document').on(
      table.employeeId,
      table.documentId,
    ),

    // Indexes
    employeeIdx: index('idx_employee_documents_employee').on(table.employeeId),
    documentIdx: index('idx_employee_documents_document').on(table.documentId),
    statusIdx: index('idx_employee_documents_status').on(table.status),
  }),
);

// ============================================
// 10. AUDIT LOGS (Enriched)
// ============================================

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    action: text('action').notNull(), // e.g., 'CREATE_EMPLOYEE', 'SEND_NOTIFICATION'
    actorId: text('actor_id').notNull(),
    actorType: text('actor_type').notNull().default('user'), // 'user', 'system', 'api', 'webhook'
    actorEmail: text('actor_email'),

    resourceId: text('resource_id'),
    resourceType: text('resource_type'), // 'Employee', 'Task', 'Document', etc.

    details: text('details', { mode: 'json' }), // { before, after, changes }

    // Contexte de la requête
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    requestId: text('request_id'),
    correlationId: text('correlation_id'),
    sessionId: text('session_id'),

    // Statut
    status: text('status').notNull().default('success'), // 'success', 'failure', 'denied'
    errorMessage: text('error_message'),

    // Timestamp
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    // Indexes
    actorIdx: index('idx_audit_logs_actor').on(table.actorId, table.actorType),
    resourceIdx: index('idx_audit_logs_resource').on(table.resourceType, table.resourceId),
    actionIdx: index('idx_audit_logs_action').on(table.action),
    statusIdx: index('idx_audit_logs_status').on(table.status),
    createdAtIdx: index('idx_audit_logs_created_at').on(table.createdAt),
    requestIdIdx: index('idx_audit_logs_request_id').on(table.requestId),
    sessionIdIdx: index('idx_audit_logs_session_id').on(table.sessionId),
  }),
);

// ============================================
// 11. CONVERSATION TURNS (Mémoire conversationnelle)
// ============================================
//
// Table unique de la feature `conversation`. L'agent « collant » d'un fil est simplement
// l'`agent_id` du dernier tour : la requête de fenêtre le ramène déjà, aucune seconde table
// n'est nécessaire.
//
// ⚠️ Écart ASSUMÉ au style des 10 tables ci-dessus : elles horodatent en `text` via
// `datetime('now')`, qui a une résolution à la SECONDE et un format sans fuseau. Ici
// l'horodatage est le discriminant du TTL *et* de l'ordre des tours ; deux messages d'un même
// échange arrivent couramment dans la même seconde, et les égalités casseraient l'ordre
// chronologique dont dépend `selectWindow`. D'où un entier en millisecondes, qui donne aussi
// un `Date` natif côté Drizzle — donc pas de reparsing pour l'arithmétique du TTL.

export const conversationTurns = sqliteTable(
  'conversation_turns',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id').notNull(), // `${channel}` ou `${channel}:${threadTs}`
    role: text('role').notNull(), // 'user' | 'assistant'
    content: text('content').notNull(), // texte seul — jamais de tool-call ni de tool-result
    agentId: text('agent_id').notNull(), // onboardingOrchestrator | questionnaireEngine | notificationAgent
    slackUserId: text('slack_user_id'), // null sur un tour assistant

    // Timestamp
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({
    // Index unique servant les deux accès : fenêtre d'une conversation (égalité + tri) et purge.
    conversationCreatedAtIdx: index('idx_conversation_turns_conversation_created_at').on(
      table.conversationId,
      table.createdAt,
    ),
    createdAtIdx: index('idx_conversation_turns_created_at').on(table.createdAt),
  }),
);

// ============================================
// 12. SLACK EVENT DEDUP (Déduplication multi-instance)
// ============================================
//
// Table unique de la déduplication PARTAGÉE des événements Slack. Le cache LRU du handler est
// en mémoire, donc par instance : il est incapable par construction d'écarter un rejeu routé
// vers une AUTRE instance pendant que la première traite encore l'événement — c'est-à-dire
// exactement le cas qui produit une double réponse (incident du 2026-08-11, 12:38 UTC).
//
// La `key` est celle du handler (`ts:<channel>:<ts>` ou `id:<event_id>`) et sert de PRIMARY
// KEY : c'est elle qui rend la prise atomique via `INSERT … ON CONFLICT DO NOTHING`.
//
// ⚠️ Même écart assumé que `conversation_turns` sur l'horodatage : entier en millisecondes et
// non `datetime('now')` en `text`. `started_at` est le discriminant de la grâce d'abandon
// (60 s) ; une résolution à la seconde y serait grossière, et le comparer exigerait un
// reparsing à chaque prise de clé — sur le chemin d'ACK, celui qui a 3 secondes.

export const slackEventDedup = sqliteTable(
  'slack_event_dedup',
  {
    key: text('key').primaryKey(), // `ts:<channel>:<ts>` ou `id:<event_id>`
    status: text('status').notNull(), // 'in-flight' | 'done'
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({
    // Sert la purge de rétention (~10 min, la fenêtre de rejeu de Slack). L'accès par clé
    // passe déjà par l'index implicite de la PRIMARY KEY.
    startedAtIdx: index('idx_slack_event_dedup_started_at').on(table.startedAt),
  }),
);

// ============================================
// 13. TYPES INFÉRÉS POUR LES REQUÊTES
// ============================================

import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';

// Select types (lecture)
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

// Insert types (création)
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

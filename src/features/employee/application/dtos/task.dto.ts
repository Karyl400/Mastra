// task.validation.ts
import { z } from 'zod';
import DOMPurify from 'isomorphic-dompurify';
import { TaskStatus, TaskType, TaskPriority } from '../../../../shared/types';
import { timestampsSchema, uuidSchema } from '../../../../shared/validation';

// ============================================
// 1. ANALYSE MÉTIER : WORKFLOW DES TÂCHES
// ============================================

/**
 * Workflow de transition de statut
 * Définit les transitions valides entre statuts
 */
const TASK_STATUS_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  [TaskStatus.Pending]: [
    TaskStatus.InProgress, 
    TaskStatus.Cancelled
  ],
  [TaskStatus.InProgress]: [
    TaskStatus.Completed, 
    TaskStatus.Blocked, 
    TaskStatus.Cancelled
  ],
  [TaskStatus.Blocked]: [
    TaskStatus.InProgress, 
    TaskStatus.Cancelled
  ],
  [TaskStatus.InReview]: [
    TaskStatus.Completed,
    TaskStatus.InProgress,
    TaskStatus.Cancelled
  ],
  [TaskStatus.Completed]: [
    TaskStatus.Archived
  ],
  [TaskStatus.Skipped]: [
    TaskStatus.Archived
  ],
  [TaskStatus.Cancelled]: [
    TaskStatus.Archived
  ],
  [TaskStatus.Archived]: [], // État final
};

/**
 * Configuration par type de tâche
 * Champs requis selon le type
 */
const TASK_TYPE_CONFIG = {
  [TaskType.Individual]: {
    requiresAssignee: true,
    allowsMultipleAssignees: false,
    maxDurationDays: 30,
  },
  [TaskType.Team]: {
    requiresAssignee: false,
    allowsMultipleAssignees: true,
    maxDurationDays: 90,
  },
  [TaskType.Review]: {
    requiresAssignee: true,
    requiresReviewer: true,
    maxDurationDays: 7,
  },
  [TaskType.Onboarding]: {
    requiresAssignee: true,
    requiresTemplate: true,
    maxDurationDays: 14,
  },
  [TaskType.Training]: {
    requiresAssignee: true,
    maxDurationDays: 60,
  },
} as const;

// ============================================
// 2. CONSTANTES DE VALIDATION
// ============================================

const TASK_CONSTRAINTS = {
  TITLE: {
    MIN_LENGTH: 3,
    MAX_LENGTH: 200,
    PATTERN: /^[^<>{}]*$/, // Pas de caractères dangereux
  },
  DESCRIPTION: {
    MAX_LENGTH: 5000,
    MAX_PLAINTEXT_LENGTH: 5000,
  },
  DUE_DATE: {
    MIN_DAYS_FROM_NOW: 0, // Pas dans le passé
    MAX_DAYS_FROM_NOW: 365, // Max 1 an
  },
  PRIORITY: {
    DEFAULT: TaskPriority.Medium,
  },
  TAGS: {
    MAX_COUNT: 10,
    MAX_LENGTH: 50,
  },
} as const;

// ============================================
// 3. SCHEMAS DE BASE RÉUTILISABLES
// ============================================

/**
 * Schema de titre avec sanitization
 */
const titleSchema = z
  .string()
  .trim()
  .min(TASK_CONSTRAINTS.TITLE.MIN_LENGTH, `Title must be at least ${TASK_CONSTRAINTS.TITLE.MIN_LENGTH} characters`)
  .max(TASK_CONSTRAINTS.TITLE.MAX_LENGTH, `Title must not exceed ${TASK_CONSTRAINTS.TITLE.MAX_LENGTH} characters`)
  .regex(TASK_CONSTRAINTS.TITLE.PATTERN, 'Title contains invalid characters')
  .transform((val) => DOMPurify.sanitize(val));

/**
 * Schema de description avec validation de contenu
 */
const descriptionSchema = z
  .string()
  .max(TASK_CONSTRAINTS.DESCRIPTION.MAX_LENGTH)
  .transform((val) => DOMPurify.sanitize(val))
  .default('');

/**
 * Schema de date d'échéance avec contraintes métier
 */
const dueDateSchema = z
  .string()
  .datetime({ message: 'Invalid date format. Expected ISO 8601' })
  .refine(
    (date) => {
      const dueDate = new Date(date);
      const now = new Date();
      const minDate = new Date();
      minDate.setDate(minDate.getDate() + TASK_CONSTRAINTS.DUE_DATE.MIN_DAYS_FROM_NOW);
      const maxDate = new Date();
      maxDate.setDate(maxDate.getDate() + TASK_CONSTRAINTS.DUE_DATE.MAX_DAYS_FROM_NOW);
      
      return dueDate >= minDate && dueDate <= maxDate;
    },
    {
      message: `Due date must be between today and ${TASK_CONSTRAINTS.DUE_DATE.MAX_DAYS_FROM_NOW} days from now`,
    }
  )
  .nullable()
  .optional();

// ============================================
// 4. SCHÉMAS DISCRIMINÉS PAR TYPE DE TÂCHE
// ============================================

/**
 * Schéma de base commun à toutes les tâches
 */
const baseTaskSchema = z.object({
  title: titleSchema,
  description: descriptionSchema,
  priority: z.nativeEnum(TaskPriority).default(TaskPriority.Medium),
  dueDate: dueDateSchema,
  tags: z.array(z.string().max(TASK_CONSTRAINTS.TAGS.MAX_LENGTH))
    .max(TASK_CONSTRAINTS.TAGS.MAX_COUNT)
    .default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Tâche individuelle
 */
const individualTaskSchema = baseTaskSchema.extend({
  type: z.literal(TaskType.Individual),
  assigneeId: uuidSchema,
  estimatedHours: z.number().min(0.5).max(160).optional(),
});

/**
 * Tâche d'équipe
 */
const teamTaskSchema = baseTaskSchema.extend({
  type: z.literal(TaskType.Team),
  teamId: uuidSchema,
  assigneeIds: z.array(uuidSchema).min(1).max(20).optional(),
});

/**
 * Tâche de revue
 */
const reviewTaskSchema = baseTaskSchema.extend({
  type: z.literal(TaskType.Review),
  assigneeId: uuidSchema,
  reviewerId: uuidSchema,
  reviewCriteria: z.array(z.string().min(1).max(200)).min(1).max(10),
});

/**
 * Tâche d'onboarding
 */
const onboardingTaskSchema = baseTaskSchema.extend({
  type: z.literal(TaskType.Onboarding),
  assigneeId: uuidSchema,
  templateId: uuidSchema,
  checklist: z.array(
    z.object({
      item: z.string().min(1).max(200),
      completed: z.boolean().default(false),
      completedAt: z.string().datetime().nullable().optional(),
    })
  ).min(1).max(50),
});

/**
 * Tâche de formation
 */
const trainingTaskSchema = baseTaskSchema.extend({
  type: z.literal(TaskType.Training),
  assigneeId: uuidSchema,
  courseId: uuidSchema.optional(),
  trainingUrl: z.string().url().optional(),
  passingScore: z.number().min(0).max(100).optional(),
});

// ============================================
// 5. SCHÉMA PRINCIPAL AVEC DISCRIMINATED UNION
// ============================================

/**
 * Schema de création avec discriminated union sur le type
 */
export const createTaskSchema = z.discriminatedUnion('type', [
  individualTaskSchema,
  teamTaskSchema,
  reviewTaskSchema,
  onboardingTaskSchema,
  trainingTaskSchema,
]);

/**
 * Schema de mise à jour (tous les champs optionnels sauf l'ID)
 */
export const updateTaskSchema = z.object({
  id: uuidSchema,
  title: titleSchema.optional(),
  description: descriptionSchema.optional(),
  priority: z.nativeEnum(TaskPriority).optional(),
  status: z.nativeEnum(TaskStatus).optional(),
  dueDate: dueDateSchema,
  tags: z.array(z.string().max(TASK_CONSTRAINTS.TAGS.MAX_LENGTH))
    .max(TASK_CONSTRAINTS.TAGS.MAX_COUNT)
    .optional(),
  completedAt: z.string().datetime().nullable().optional(),
});

// ============================================
// 6. VALIDATION DE COHÉRENCE TEMPORELLE
// ============================================

/**
 * Schema avec validation de cohérence temporelle
 */
const temporalCoherenceRefinement = z.object({
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
}).refine(
  (data) => {
    // completedAt doit être postérieur à createdAt
    if (data.completedAt) {
      return new Date(data.completedAt) >= new Date(data.createdAt);
    }
    return true;
  },
  {
    message: 'completedAt must be after createdAt',
    path: ['completedAt'],
  }
).refine(
  (data) => {
    // Si completedAt existe, le statut doit être Completed ou Archived
    if (data.completedAt) {
      // Cette validation est dans le DTO complet
    }
    return true;
  }
);

// ============================================
// 7. DTO DE RÉPONSE (SANITIZED)
// ============================================

/**
 * DTO pour les réponses API
 * Contient les champs calculés et relations
 */
export const taskDtoSchema = z.object({
  id: uuidSchema,
  type: z.nativeEnum(TaskType),
  title: z.string(),
  description: z.string(),
  status: z.nativeEnum(TaskStatus),
  priority: z.nativeEnum(TaskPriority),
  
  // Relations - adaptées selon le type
  assigneeId: uuidSchema.nullable().optional(),
  assigneeIds: z.array(uuidSchema).optional(),
  reviewerId: uuidSchema.nullable().optional(),
  teamId: uuidSchema.nullable().optional(),
  
  // Dates
  dueDate: z.string().datetime().nullable().optional(),
  completedAt: z.string().datetime().nullable().optional(),
  
  // Métadonnées
  tags: z.array(z.string()),
  metadata: z.record(z.string(), z.unknown()),
  
  // Champs calculés
  isOverdue: z.boolean().optional(),
  daysUntilDue: z.number().nullable().optional(),
  completionPercentage: z.number().min(0).max(100).optional(),
  
  // Relations peuplées (optionnelles)
  assignee: z.object({
    id: uuidSchema,
    name: z.string(),
  }).nullable().optional(),
  
}).merge(timestampsSchema);

// ============================================
// 8. VALIDATEUR AVEC LOGIQUE MÉTIER
// ============================================

export class TaskValidator {
  /**
   * Valide la création d'une tâche avec règles métier
   */
  static async validateCreate(data: unknown): Promise<CreateTaskInput> {
    const validated = await createTaskSchema.parseAsync(data);
    
    // Validation métier supplémentaire
    await this.validateBusinessRules(validated);
    
    return validated;
  }
  
  /**
   * Valide la mise à jour avec vérification de transition
   */
  static async validateUpdate(
    taskId: string, 
    data: unknown
  ): Promise<UpdateTaskInput> {
    const currentTask = await this.getCurrentTask(taskId);
    const validated = await updateTaskSchema.parseAsync(data);
    
    // Vérifier les transitions de statut
    if (validated.status && currentTask) {
      this.validateStatusTransition(currentTask.status, validated.status);
    }
    
    // Vérifier la cohérence temporelle
    if (validated.completedAt && currentTask) {
      this.validateTemporalCoherence(currentTask, validated);
    }
    
    return validated;
  }
  
  /**
   * Règles métier complexes
   */
  private static async validateBusinessRules(task: CreateTaskInput): Promise<void> {
    const config = TASK_TYPE_CONFIG[task.type];
    
    // Vérifier les contraintes de durée max
    if (task.dueDate && config.maxDurationDays) {
      const dueDate = new Date(task.dueDate);
      const now = new Date();
      const maxDate = new Date(now.getTime() + config.maxDurationDays * 86400000);
      
      if (dueDate > maxDate) {
        throw new TaskValidationError(
          `Tasks of type ${task.type} cannot exceed ${config.maxDurationDays} days`
        );
      }
    }
    
    // Vérifier les contraintes d'assignation
    if (config.requiresAssignee && !this.hasAssignee(task)) {
      throw new TaskValidationError(
        `Tasks of type ${task.type} require an assignee`
      );
    }
    
    // Vérifier l'unicité des titres pour les tâches actives ?
    // await this.checkDuplicateTitle(task.title, task.assigneeId);
  }
  
  /**
   * Vérifie la validité d'une transition de statut
   */
  static validateStatusTransition(
    from: TaskStatus, 
    to: TaskStatus
  ): void {
    const allowedTransitions = TASK_STATUS_TRANSITIONS[from];
    
    if (!allowedTransitions.includes(to)) {
      throw new TaskValidationError(
        `Cannot transition from ${from} to ${to}. Allowed: ${allowedTransitions.join(', ')}`
      );
    }
  }
  
  /**
   * Vérifie la cohérence temporelle
   */
  private static validateTemporalCoherence(
    currentTask: TaskDto,
    update: UpdateTaskInput
  ): void {
    if (update.completedAt) {
      const completedDate = new Date(update.completedAt);
      const createdDate = new Date(currentTask.createdAt);
      
      if (completedDate < createdDate) {
        throw new TaskValidationError(
          'Completion date cannot be before creation date'
        );
      }
    }
  }
  
  /**
   * Sanitize pour la réponse API
   */
  static sanitizeResponse(task: TaskDto): TaskDto {
    // Retirer les champs internes sensibles
    const { ...safeTask } = task;
    return safeTask;
  }
  
  // Méthodes utilitaires
  private static hasAssignee(task: Pick<TaskDto, 'assigneeId'> & { assigneeIds?: string[] }): boolean {
    return !!(
      task.assigneeId || 
      (task.assigneeIds && task.assigneeIds.length > 0)
    );
  }
  
  private static async getCurrentTask(taskId: string): Promise<TaskDto | null> {
    // Simulation - À remplacer par un appel DB
    return null;
  }
}

// ============================================
// 9. GESTION D'ERREURS
// ============================================

export class TaskValidationError extends Error {
  public readonly code = 'TASK_VALIDATION_ERROR';
  public readonly statusCode = 422;
  
  constructor(
    message: string,
    public readonly details?: z.ZodIssue[]
  ) {
    super(message);
    this.name = 'TaskValidationError';
  }
  
  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details?.map(d => ({
          field: d.path.join('.'),
          message: d.message,
        })),
      },
    };
  }
}

// ============================================
// 10. TYPES INFÉRÉS
// ============================================

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type TaskDto = z.infer<typeof taskDtoSchema>;

// Types utilitaires
export type TaskTypeConfig = typeof TASK_TYPE_CONFIG;
export type ValidTransition = keyof typeof TASK_STATUS_TRANSITIONS;

// ============================================
// 11. HOOKS DE CYCLE DE VIE
// ============================================

export const taskLifecycleHooks = {
  /**
   * Avant création
   */
  beforeCreate: (data: CreateTaskInput): CreateTaskInput => {
    return {
      ...data,
      title: data.title.trim(),
      tags: [...new Set(data.tags)], // Déduplication
    };
  },
  
  /**
   * Après création - actions side-effect
   */
  afterCreate: async (task: TaskDto): Promise<void> => {
    // Notifier l'assigné
    // Logger l'événement
    // Mettre à jour les métriques
  },
  
  /**
   * Avant mise à jour
   */
  beforeUpdate: async (
    taskId: string, 
    update: UpdateTaskInput
  ): Promise<UpdateTaskInput> => {
    // Si le statut passe à "Completed", set completedAt
    if (update.status === TaskStatus.Completed && !update.completedAt) {
      return {
        ...update,
        completedAt: new Date().toISOString(),
      };
    }
    return update;
  },
};

// ============================================
// 12. UTILITAIRES DE CALCUL
// ============================================

export const taskCalculations = {
  /**
   * Calcule si une tâche est en retard
   */
  isOverdue(task: Pick<TaskDto, 'dueDate' | 'status' | 'completedAt'>): boolean {
    if (!task.dueDate) return false;
    if ([TaskStatus.Completed, TaskStatus.Cancelled, TaskStatus.Archived].includes(task.status)) {
      return false;
    }
    return new Date(task.dueDate) < new Date();
  },
  
  /**
   * Calcule le pourcentage de complétion
   */
  getCompletionPercentage(task: TaskDto): number {
    // Logique selon le type de tâche
    if (task.type === TaskType.Onboarding && 'checklist' in task) {
      const checklist = (task as TaskDto & { checklist?: Array<{ completed: boolean }> }).checklist ?? [];
      if (checklist.length === 0) return 0;
      const completed = checklist.filter((item: { completed: boolean }) => item.completed).length;
      return Math.round((completed / checklist.length) * 100);
    }
    
    // Tâches simples : binaire
    return task.status === TaskStatus.Completed ? 100 : 0;
  },
};


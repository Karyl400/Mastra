// ============================================
// domain/entities/task.ts - Task Domain Entity
// Standards 2026: Rich Domain Model, Value Objects, State Machine
// ============================================

import {
  TaskStatus,
  TaskType,
  TaskPriority,
  TASK_STATUS_TRANSITIONS,
  isValidTaskTransition,
  isTaskFinalStatus,
} from '../../../shared/types';
import type { Timestamps } from '../../../shared/types';
import { randomUUID } from 'crypto';
import { DomainError } from '../../../shared/errors';

// ============================================
// 1. VALUE OBJECTS
// ============================================

/**
 * Identifiant de tâche (branded type)
 */
export type TaskId = string & { readonly __brand: 'TaskId' };

/**
 * Identifiant d'employé (branded type)
 */
export type EmployeeId = string & { readonly __brand: 'EmployeeId' };

/**
 * Titre de tâche (value object avec validation)
 */
class TaskTitle {
  private constructor(private readonly value: string) {}
  
  static create(title: string): TaskTitle {
    const trimmed = title.trim();
    
    if (trimmed.length < 3) {
      throw new DomainError('Task title must be at least 3 characters');
    }
    if (trimmed.length > 200) {
      throw new DomainError('Task title must not exceed 200 characters');
    }
    if (/[<>{}[\]\\]/.test(trimmed)) {
      throw new DomainError('Task title contains invalid characters');
    }
    
    return new TaskTitle(trimmed);
  }
  
  toString(): string {
    return this.value;
  }
  
  equals(other: TaskTitle): boolean {
    return this.value === other.value;
  }
}

/**
 * Description de tâche (value object avec validation)
 */
class TaskDescription {
  private constructor(private readonly value: string) {}
  
  static create(description?: string): TaskDescription {
    const sanitized = (description || '').trim();
    
    if (sanitized.length > 5000) {
      throw new DomainError('Task description must not exceed 5000 characters');
    }
    
    return new TaskDescription(sanitized);
  }
  
  toString(): string {
    return this.value;
  }
  
  isEmpty(): boolean {
    return this.value.length === 0;
  }
}

/**
 * Date d'échéance (value object avec validation)
 */
class DueDate {
  private constructor(private readonly value: Date | null) {}
  
  static create(dateStr?: string | null): DueDate {
    if (!dateStr) {
      return new DueDate(null);
    }
    
    const date = new Date(dateStr);
    
    if (isNaN(date.getTime())) {
      throw new DomainError('Invalid due date format');
    }
    
    // Ne peut pas être dans le passé
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    
    if (date < now) {
      throw new DomainError('Due date cannot be in the past');
    }
    
    // Ne peut pas être à plus d'un an
    const maxDate = new Date();
    maxDate.setFullYear(maxDate.getFullYear() + 1);
    
    if (date > maxDate) {
      throw new DomainError('Due date cannot be more than one year in the future');
    }
    
    return new DueDate(date);
  }
  
  isOverdue(): boolean {
    if (!this.value) return false;
    return this.value < new Date();
  }
  
  toISOString(): string | null {
    return this.value?.toISOString() || null;
  }
  
  daysUntilDue(): number | null {
    if (!this.value) return null;
    const now = new Date();
    const diff = this.value.getTime() - now.getTime();
    return Math.ceil(diff / (1000 * 60 * 60 * 24));
  }
}

// ============================================
// 2. TASK STATE (Value Object for Status)
// ============================================

/**
 * Statut de tâche avec comportement
 */
class TaskState {
  private constructor(private readonly status: TaskStatus) {}
  
  static create(status: TaskStatus = TaskStatus.Pending): TaskState {
    if (!Object.values(TaskStatus).includes(status)) {
      throw new DomainError(`Invalid task status: ${status}`);
    }
    return new TaskState(status);
  }
  
  /**
   * Transition vers un nouveau statut (retourne un NOUVEAU TaskState)
   */
  transition(newStatus: TaskStatus): TaskState {
    if (!isValidTaskTransition(this.status, newStatus)) {
      throw new DomainError(
        `Invalid status transition from "${this.status}" to "${newStatus}"`
      );
    }
    return new TaskState(newStatus);
  }
  
  isFinal(): boolean {
    return isTaskFinalStatus(this.status);
  }
  
  isActive(): boolean {
    return [
      TaskStatus.Pending,
      TaskStatus.InProgress,
      TaskStatus.Blocked,
      TaskStatus.InReview,
    ].includes(this.status);
  }
  
  canBeModified(): boolean {
    return !this.isFinal();
  }
  
  get value(): TaskStatus {
    return this.status;
  }
  
  equals(other: TaskState): boolean {
    return this.status === other.status;
  }
}

// ============================================
// 3. TASK AGGREGATE ROOT
// ============================================

/**
 * Entité Tâche (Aggregate Root)
 * 
 * Encapsule les règles métier et garantit la cohérence
 * de l'agrégat en tout temps.
 */
export class Task {
  private constructor(
    public readonly id: TaskId,
    public readonly employeeId: EmployeeId,
    private title: TaskTitle,
    private description: TaskDescription,
    public readonly type: TaskType,
    private state: TaskState,
    private priority: TaskPriority,
    private dueDate: DueDate,
    private readonly assigneeId: EmployeeId | null,
    private readonly reviewerId: EmployeeId | null,
    private completedAt: Date | null,
    private startedAt: Date | null,
    private tags: string[],
    private estimatedHours: number | null,
    private actualHours: number | null,
    public readonly createdAt: string,
    private updatedAt: string,
    public readonly deletedAt?: string | null,
  ) {}
  
  // ============================================
  // FACTORY METHOD
  // ============================================
  
  /**
   * Crée une nouvelle tâche
   */
  static create(input: CreateTaskInput): Task {
    const now = new Date().toISOString();
    const id = input.id || randomUUID() as TaskId;
    
    // Valider que l'employeeId est fourni
    if (!input.employeeId) {
      throw new DomainError('Employee ID is required');
    }
    
    // Valider que le type est valide
    if (!Object.values(TaskType).includes(input.type)) {
      throw new DomainError(`Invalid task type: ${input.type}`);
    }
    
    // Un assigneeId est requis pour les tâches individuelles
    if (input.type === TaskType.Review && !input.assigneeId) {
      throw new DomainError('Assignee is required for review tasks');
    }
    
    const task = new Task(
      id,
      input.employeeId as EmployeeId,
      TaskTitle.create(input.title),
      TaskDescription.create(input.description),
      input.type,
      TaskState.create(TaskStatus.Pending),
      input.priority || TaskPriority.Medium,
      DueDate.create(input.dueDate),
      input.assigneeId as EmployeeId || null,
      input.reviewerId as EmployeeId || null,
      null, // completedAt
      null, // startedAt
      input.tags || [],
      input.estimatedHours || null,
      null, // actualHours
      now,
      now,
      null,
    );
    
    return task;
  }
  
  /**
   * Reconstitue une tâche existante (depuis la persistence)
   */
  static reconstitute(data: TaskPersistence): Task {
    // Valider les données persistées
    if (!data.id) throw new DomainError('Task ID is required');
    if (!data.employeeId) throw new DomainError('Employee ID is required');
    
    return new Task(
      data.id as TaskId,
      data.employeeId as EmployeeId,
      TaskTitle.create(data.title),
      TaskDescription.create(data.description),
      data.type,
      TaskState.create(data.status),
      data.priority || TaskPriority.Medium,
      DueDate.create(data.dueDate),
      data.assigneeId as EmployeeId || null,
      data.reviewerId as EmployeeId || null,
      data.completedAt ? new Date(data.completedAt) : null,
      data.startedAt ? new Date(data.startedAt) : null,
      data.tags || [],
      data.estimatedHours || null,
      data.actualHours || null,
      data.createdAt,
      data.updatedAt,
      data.deletedAt,
    );
  }
  
  // ============================================
  // COMMANDS (Méthodes métier qui modifient l'état)
  // ============================================
  
  /**
   * Démarre la tâche
   */
  start(): void {
    if (!this.state.canBeModified()) {
      throw new DomainError(`Cannot start a task in status "${this.state.value}"`);
    }
    
    if (this.state.value === TaskStatus.Pending) {
      this.state = this.state.transition(TaskStatus.InProgress);
      this.startedAt = new Date();
      this.touch();
    }
  }
  
  /**
   * Bloque la tâche (dépendance externe)
   */
  block(reason?: string): void {
    if (!this.state.canBeModified()) {
      throw new DomainError(`Cannot block a task in status "${this.state.value}"`);
    }
    
    this.state = this.state.transition(TaskStatus.Blocked);
    this.touch();
  }
  
  /**
   * Débloque la tâche
   */
  unblock(): void {
    if (this.state.value !== TaskStatus.Blocked) {
      throw new DomainError('Can only unblock a blocked task');
    }
    
    this.state = this.state.transition(TaskStatus.InProgress);
    this.touch();
  }
  
  /**
   * Soumet la tâche pour revue
   */
  submitForReview(): void {
    if (![TaskStatus.InProgress, TaskStatus.Blocked].includes(this.state.value)) {
      throw new DomainError(`Cannot submit task in status "${this.state.value}" for review`);
    }
    
    if (!this.reviewerId) {
      throw new DomainError('Cannot submit for review without a reviewer assigned');
    }
    
    this.state = this.state.transition(TaskStatus.InReview);
    this.touch();
  }
  
  /**
   * Approuve la tâche (reviewer)
   */
  approve(reviewerId: EmployeeId): void {
    if (this.state.value !== TaskStatus.InReview) {
      throw new DomainError('Can only approve a task in review');
    }
    
    if (this.reviewerId !== reviewerId) {
      throw new DomainError('Only the assigned reviewer can approve this task');
    }
    
    this.state = this.state.transition(TaskStatus.Completed);
    this.completedAt = new Date();
    this.touch();
  }
  
  /**
   * Rejette la tâche (reviewer)
   */
  reject(reviewerId: EmployeeId, reason?: string): void {
    if (this.state.value !== TaskStatus.InReview) {
      throw new DomainError('Can only reject a task in review');
    }
    
    if (this.reviewerId !== reviewerId) {
      throw new DomainError('Only the assigned reviewer can reject this task');
    }
    
    this.state = this.state.transition(TaskStatus.InProgress);
    this.touch();
  }
  
  /**
   * Marque la tâche comme complétée (sans revue)
   */
  complete(): void {
    if (this.state.value !== TaskStatus.InProgress) {
      throw new DomainError(`Cannot complete task in status "${this.state.value}"`);
    }
    
    // Si un reviewer est assigné, forcer la revue
    if (this.reviewerId) {
      throw new DomainError('Task has a reviewer assigned, use submitForReview() first');
    }
    
    this.state = this.state.transition(TaskStatus.Completed);
    this.completedAt = new Date();
    this.touch();
  }
  
  /**
   * Saute la tâche (non applicable)
   */
  skip(reason?: string): void {
    if (!this.state.canBeModified()) {
      throw new DomainError(`Cannot skip a task in status "${this.state.value}"`);
    }
    
    this.state = this.state.transition(TaskStatus.Skipped);
    this.touch();
  }
  
  /**
   * Annule la tâche
   */
  cancel(reason?: string): void {
    if (this.state.isFinal()) {
      throw new DomainError(`Cannot cancel a task in final status "${this.state.value}"`);
    }
    
    this.state = this.state.transition(TaskStatus.Cancelled);
    this.touch();
  }
  
  /**
   * Archive la tâche (depuis un état final)
   */
  archive(): void {
    if (!this.state.isFinal()) {
      throw new DomainError('Can only archive a task in a final status');
    }
    
    this.state = this.state.transition(TaskStatus.Archived);
    this.touch();
  }
  
  // ============================================
  // MUTATIONS (Modifications des propriétés)
  // ============================================
  
  /**
   * Modifie le titre
   */
  changeTitle(newTitle: string): void {
    if (!this.state.canBeModified()) {
      throw new DomainError('Cannot modify a task in a final status');
    }
    
    this.title = TaskTitle.create(newTitle);
    this.touch();
  }
  
  /**
   * Modifie la description
   */
  changeDescription(newDescription: string): void {
    if (!this.state.canBeModified()) {
      throw new DomainError('Cannot modify a task in a final status');
    }
    
    this.description = TaskDescription.create(newDescription);
    this.touch();
  }
  
  /**
   * Reporte la date d'échéance
   */
  postpone(newDueDate: string): void {
    if (!this.state.canBeModified()) {
      throw new DomainError('Cannot modify a task in a final status');
    }
    
    this.dueDate = DueDate.create(newDueDate);
    this.touch();
  }
  
  /**
   * Change la priorité
   */
  changePriority(newPriority: TaskPriority): void {
    if (!this.state.canBeModified()) {
      throw new DomainError('Cannot modify a task in a final status');
    }
    
    if (!Object.values(TaskPriority).includes(newPriority)) {
      throw new DomainError(`Invalid priority: ${newPriority}`);
    }
    
    this.priority = newPriority;
    this.touch();
  }
  
  /**
   * Ajoute un tag
   */
  addTag(tag: string): void {
    const normalized = tag.trim().toLowerCase();
    
    if (!normalized) {
      throw new DomainError('Tag cannot be empty');
    }
    if (normalized.length > 50) {
      throw new DomainError('Tag must not exceed 50 characters');
    }
    if (this.tags.length >= 10) {
      throw new DomainError('Maximum 10 tags allowed');
    }
    if (this.tags.includes(normalized)) {
      return; // Déjà présent, idempotent
    }
    
    this.tags.push(normalized);
    this.touch();
  }
  
  /**
   * Supprime un tag
   */
  removeTag(tag: string): void {
    const normalized = tag.trim().toLowerCase();
    this.tags = this.tags.filter(t => t !== normalized);
    this.touch();
  }
  
  /**
   * Enregistre les heures passées
   */
  logHours(hours: number): void {
    if (hours <= 0) {
      throw new DomainError('Hours must be positive');
    }
    if (hours > 24) {
      throw new DomainError('Cannot log more than 24 hours at once');
    }
    
    this.actualHours = (this.actualHours || 0) + hours;
    this.touch();
  }
  
  // ============================================
  // QUERIES (Méthodes de lecture)
  // ============================================
  
  get status(): TaskStatus {
    return this.state.value;
  }
  
  get isOverdue(): boolean {
    return this.dueDate.isOverdue() && this.state.isActive();
  }
  
  get daysUntilDue(): number | null {
    return this.dueDate.daysUntilDue();
  }
  
  get isActive(): boolean {
    return this.state.isActive();
  }
  
  get canBeModified(): boolean {
    return this.state.canBeModified();
  }
  
  get completionPercentage(): number {
    if (this.state.value === TaskStatus.Completed) return 100;
    if (this.state.value === TaskStatus.InReview) return 90;
    if (this.state.value === TaskStatus.InProgress) {
      // Si on a des heures estimées et actuelles
      if (this.estimatedHours && this.actualHours) {
        return Math.min(Math.round((this.actualHours / this.estimatedHours) * 100), 99);
      }
      return 50;
    }
    if (this.state.value === TaskStatus.Pending) return 0;
    return 0;
  }
  
  // ============================================
  // TO DTO (Pour la couche de présentation)
  // ============================================
  
  /**
   * Convertit l'entité en DTO pour l'API
   */
  toDto(): TaskDto {
    return {
      id: this.id,
      employeeId: this.employeeId,
      title: this.title.toString(),
      description: this.description.toString(),
      type: this.type,
      status: this.status,
      priority: this.priority,
      dueDate: this.dueDate.toISOString(),
      assigneeId: this.assigneeId,
      reviewerId: this.reviewerId,
      completedAt: this.completedAt?.toISOString() || null,
      startedAt: this.startedAt?.toISOString() || null,
      tags: [...this.tags],
      estimatedHours: this.estimatedHours,
      actualHours: this.actualHours,
      isOverdue: this.isOverdue,
      daysUntilDue: this.daysUntilDue,
      completionPercentage: this.completionPercentage,
      canBeModified: this.canBeModified,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      deletedAt: this.deletedAt || null,
    };
  }
  
  /**
   * Convertit en objet pour la persistence
   */
  toPersistence(): TaskPersistence {
    return {
      id: this.id,
      employeeId: this.employeeId,
      title: this.title.toString(),
      description: this.description.toString(),
      type: this.type,
      status: this.status,
      priority: this.priority,
      dueDate: this.dueDate.toISOString(),
      assigneeId: this.assigneeId,
      reviewerId: this.reviewerId,
      completedAt: this.completedAt?.toISOString() || null,
      startedAt: this.startedAt?.toISOString() || null,
      tags: this.tags,
      estimatedHours: this.estimatedHours,
      actualHours: this.actualHours,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      deletedAt: this.deletedAt || null,
    };
  }
  
  // ============================================
  // PRIVATE HELPERS
  // ============================================
  
  private touch(): void {
    this.updatedAt = new Date().toISOString();
  }
}

// ============================================
// 4. TYPES
// ============================================

/** Input pour la création d'une tâche */
interface CreateTaskInput {
  id?: string;
  employeeId: string;
  title: string;
  description?: string;
  type: TaskType;
  priority?: TaskPriority;
  dueDate?: string | null;
  assigneeId?: string | null;
  reviewerId?: string | null;
  tags?: string[];
  estimatedHours?: number | null;
}

/** Structure de persistence */
interface TaskPersistence {
  id: string;
  employeeId: string;
  title: string;
  description: string;
  type: TaskType;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
  assigneeId: string | null;
  reviewerId: string | null;
  completedAt: string | null;
  startedAt: string | null;
  tags: string[];
  estimatedHours: number | null;
  actualHours: number | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

/** DTO pour l'API */
interface TaskDto {
  id: string;
  employeeId: string;
  title: string;
  description: string;
  type: TaskType;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
  assigneeId: string | null;
  reviewerId: string | null;
  completedAt: string | null;
  startedAt: string | null;
  tags: string[];
  estimatedHours: number | null;
  actualHours: number | null;
  isOverdue: boolean;
  daysUntilDue: number | null;
  completionPercentage: number;
  canBeModified: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

// ============================================
// 5. LEGACY COMPATIBILITY
// ============================================

/**
 * @deprecated Utiliser Task.create() à la place
 */
export function createTask(data: Omit<TaskPersistence, 'status' | 'createdAt' | 'updatedAt' | 'priority' | 'tags' | 'estimatedHours' | 'actualHours'>): TaskPersistence {
  const now = new Date().toISOString();
  return {
    ...data,
    status: TaskStatus.Pending,
    priority: TaskPriority.Medium,
    tags: [],
    estimatedHours: null,
    actualHours: null,
    completedAt: data.completedAt || null,
    createdAt: now,
    updatedAt: now,
  };
}

// ============================================
// 6. EXPORTS
// ============================================

export { Task };
export type {
  TaskId,
  EmployeeId,
  CreateTaskInput,
  TaskPersistence,
  TaskDto,
};

// Value Objects (pour tests unitaires)
export {
  TaskTitle,
  TaskDescription,
  DueDate,
  TaskState,
};
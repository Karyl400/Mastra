import { TaskStatus, TaskType, TaskPriority, type Timestamps } from '../../../../shared/types';

export interface Task extends Timestamps {
  readonly id: string;
  readonly employeeId: string;
  readonly assigneeId: string | null;
  readonly reviewerId: string | null;
  readonly title: string;
  readonly description: string;
  readonly type: TaskType;
  readonly status: TaskStatus;
  readonly priority: TaskPriority;
  readonly dueDate: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly deletedAt: string | null;
  readonly tags: string[];
  readonly metadata: Record<string, unknown> | null;
  readonly version: number;
  readonly estimatedHours: number | null;
  readonly actualHours: number | null;
}

export function createTask(
  data: Omit<Task, keyof Timestamps | 'status' | 'version' | 'completedAt' | 'startedAt' | 'deletedAt'>
): Task {
  const now = new Date().toISOString();
  return Object.freeze({
    ...data,
    status: TaskStatus.Pending,
    version: 1,
    completedAt: null,
    startedAt: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  });
}
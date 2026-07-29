import { TaskStatus, TaskType, type Timestamps } from '../../../../shared/types';

export interface Task extends Timestamps {
  readonly id: string;
  readonly employeeId: string;
  readonly title: string;
  readonly description: string;
  readonly type: TaskType;
  readonly status: TaskStatus;
  readonly dueDate?: string | null;
  readonly assignedTo?: string | null;
  readonly completedAt?: string | null;
}

export function createTask(data: Omit<Task, keyof Timestamps | 'status'>): Task {
  const now = new Date().toISOString();
  return {
    ...data,
    status: TaskStatus.Pending,
    createdAt: now,
    updatedAt: now,
  };
}

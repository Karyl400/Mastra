import type { Task } from '../entities/task';

export interface TaskRepository {
  findById(id: string): Promise<Task | null>;
  findByEmployee(employeeId: string): Promise<Task[]>;
  save(task: Task): Promise<void>;
  update(task: Task): Promise<void>;
}

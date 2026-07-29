import type { Task } from '../../domain/entities/task';
import type { TaskRepository } from '../../domain/ports/task.repository';

export class InMemoryTaskRepository implements TaskRepository {
  private store = new Map<string, Task>();

  async findById(id: string): Promise<Task | null> {
    return this.store.get(id) ?? null;
  }

  async findByEmployee(employeeId: string): Promise<Task[]> {
    return Array.from(this.store.values()).filter(t => t.employeeId === employeeId);
  }

  async save(task: Task): Promise<void> {
    this.store.set(task.id, task);
  }

  async update(task: Task): Promise<void> {
    this.store.set(task.id, task);
  }
}

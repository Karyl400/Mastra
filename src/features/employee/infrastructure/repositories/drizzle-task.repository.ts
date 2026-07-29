import { eq } from 'drizzle-orm';
import { getDb } from '../../../../infrastructure/database/connection';
import { tasks } from '../../../../infrastructure/database/schema';
import { Task } from '../../domain/entities/task';
import { TaskRepository } from '../../domain/ports/task.repository';

export class DrizzleTaskRepository implements TaskRepository {
  async save(task: Task): Promise<void> {
    const db = getDb();
    await db.insert(tasks).values(task).onConflictDoUpdate({
      target: tasks.id,
      set: task,
    });
  }

  async update(task: Task): Promise<void> {
    await this.save(task);
  }

  async findById(id: string): Promise<Task | null> {
    const db = getDb();
    const result = await db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!result) return null;
    return result as Task;
  }

  async findByEmployee(employeeId: string): Promise<Task[]> {
    const db = getDb();
    const result = await db.select().from(tasks).where(eq(tasks.employeeId, employeeId));
    return result as Task[];
  }
}

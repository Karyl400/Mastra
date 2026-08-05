import { eq } from 'drizzle-orm';
import { getDb } from '../../../../infrastructure/database/connection';
import { tasks } from '../../../../infrastructure/database/schema';
import type { Task } from '../../domain/entities/task';
import type { TaskRepository } from '../../domain/ports/task.repository';

export class DrizzleTaskRepository implements TaskRepository {
  async save(task: Task): Promise<void> {
    const db = getDb();
    await db.insert(tasks).values({
      id: task.id,
      employeeId: task.employeeId,
      assigneeId: task.assigneeId,
      reviewerId: task.reviewerId,
      title: task.title,
      description: task.description,
      type: task.type,
      status: task.status,
      priority: task.priority,
      dueDate: task.dueDate,
      tags: task.tags,
      metadata: task.metadata,
      startedAt: task.startedAt,
      estimatedHours: task.estimatedHours,
      actualHours: task.actualHours,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      completedAt: task.completedAt,
      deletedAt: task.deletedAt,
    }).onConflictDoUpdate({
      target: tasks.id,
      set: {
        status: task.status,
        priority: task.priority,
        dueDate: task.dueDate,
        tags: task.tags,
        metadata: task.metadata,
        startedAt: task.startedAt,
        estimatedHours: task.estimatedHours,
        actualHours: task.actualHours,
        updatedAt: task.updatedAt,
        completedAt: task.completedAt,
        deletedAt: task.deletedAt,
      },
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
    const results = await db.select().from(tasks).where(eq(tasks.employeeId, employeeId));
    return results as Task[];
  }
}

import { eq, inArray } from 'drizzle-orm';
import { getDb } from '../../../../infrastructure/database/connection';
import { notifications } from '../../../../infrastructure/database/schema';
import { Notification } from '../../domain/entities/notification';
import { NotificationRepository } from '../../domain/ports/notification.repository';
import { NotificationStatus } from '../../../../shared/types';

export class DrizzleNotificationRepository implements NotificationRepository {
  async save(notification: Notification): Promise<void> {
    const db = getDb();
    await db.insert(notifications).values(notification).onConflictDoUpdate({
      target: notifications.id,
      set: notification,
    });
  }

  async update(notification: Notification): Promise<void> {
    await this.save(notification);
  }

  async findById(id: string): Promise<Notification | null> {
    const db = getDb();
    const result = await db.select().from(notifications).where(eq(notifications.id, id)).get();
    if (!result) return null;
    return result as Notification;
  }

  async findByRecipient(recipientId: string): Promise<Notification[]> {
    const db = getDb();
    const result = await db
      .select()
      .from(notifications)
      .where(eq(notifications.recipientId, recipientId));
    return result as Notification[];
  }

  async findPending(): Promise<Notification[]> {
    const db = getDb();
    const result = await db
      .select()
      .from(notifications)
      .where(
        inArray(notifications.status, [NotificationStatus.Pending, NotificationStatus.Scheduled]),
      );
    return result as Notification[];
  }
}

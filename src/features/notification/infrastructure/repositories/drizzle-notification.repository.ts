import { and, eq, inArray, lt, or } from 'drizzle-orm';
import { getDb, type DatabaseInstance } from '../../../../infrastructure/database/connection';
import { notifications } from '../../../../infrastructure/database/schema';
import type { Notification } from '../../domain/entities/notification';
import type { NotificationRepository } from '../../domain/ports/notification.repository';
import {
  DISPATCHABLE_STATUSES,
  DISPATCH_LOOKUP_STATUSES,
} from '../../domain/services/reminder-dispatch';
import { NotificationStatus } from '../../../../shared/types';

export class DrizzleNotificationRepository implements NotificationRepository {
  constructor(private readonly resolveDb: () => DatabaseInstance = getDb) {}

  async save(notification: Notification): Promise<void> {
    const db = this.resolveDb();
    await db.insert(notifications).values(notification).onConflictDoUpdate({
      target: notifications.id,
      set: notification,
    });
  }

  async update(notification: Notification): Promise<void> {
    await this.save(notification);
  }

  async findById(id: string): Promise<Notification | null> {
    const db = this.resolveDb();
    const result = await db.select().from(notifications).where(eq(notifications.id, id)).get();
    if (!result) return null;
    return result as Notification;
  }

  async findByRecipient(recipientId: string): Promise<Notification[]> {
    const db = this.resolveDb();
    const result = await db
      .select()
      .from(notifications)
      .where(eq(notifications.recipientId, recipientId));
    return result as Notification[];
  }

  async findPending(): Promise<Notification[]> {
    const db = this.resolveDb();
    const result = await db
      .select()
      .from(notifications)
      .where(inArray(notifications.status, [...DISPATCH_LOOKUP_STATUSES]));
    return result as Notification[];
  }

  async claimForDispatch(id: string, strandedBefore?: Date): Promise<boolean> {
    const db = this.resolveDb();

    const free = inArray(notifications.status, [...DISPATCHABLE_STATUSES]);
    const takeable = strandedBefore
      ? or(
          free,
          and(
            eq(notifications.status, NotificationStatus.Sending),
            lt(notifications.updatedAt, strandedBefore.toISOString()),
          ),
        )
      : free;

    const result = await db
      .update(notifications)
      .set({ status: NotificationStatus.Sending, updatedAt: new Date().toISOString() })
      .where(and(eq(notifications.id, id), takeable));

    return readAffectedRows(result) === 1;
  }

  async releaseClaim(id: string): Promise<void> {
    const db = this.resolveDb();
    await db
      .update(notifications)
      .set({ status: NotificationStatus.Scheduled, updatedAt: new Date().toISOString() })
      .where(and(eq(notifications.id, id), eq(notifications.status, NotificationStatus.Sending)));
  }
}

function readAffectedRows(result: unknown): number {
  const node = result as { rowsAffected?: unknown; changes?: unknown } | null;
  if (typeof node?.rowsAffected === 'number') return node.rowsAffected;
  if (typeof node?.changes === 'number') return node.changes;
  return 0;
}

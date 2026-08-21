import { and, eq, inArray } from 'drizzle-orm';
import { getDb, type DatabaseInstance } from '../../../../infrastructure/database/connection';
import { notifications } from '../../../../infrastructure/database/schema';
import { Notification } from '../../domain/entities/notification';
import { NotificationRepository } from '../../domain/ports/notification.repository';
import { NotificationStatus } from '../../../../shared/types';

export class DrizzleNotificationRepository implements NotificationRepository {
  // ⚠️ Injectable pour que le contrat de PRISE soit exercé contre du VRAI SQL : « l'UPDATE n'a
  // touché aucune ligne » ne se démontre pas contre une doublure. Même forme que
  // `DrizzlePendingInterviewEmailRepository`, et pour la même raison.
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
      .where(
        inArray(notifications.status, [NotificationStatus.Pending, NotificationStatus.Scheduled]),
      );
    return result as Notification[];
  }

  async claimForDispatch(id: string): Promise<boolean> {
    const db = this.resolveDb();
    // `Sending` est l'état de PRISE : il n'est écrit que par ce chemin, et `findPending()` ne
    // le rend pas — un rappel pris ne peut donc plus être re-sélectionné.
    const result = await db
      .update(notifications)
      .set({ status: NotificationStatus.Sending, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(notifications.id, id),
          inArray(notifications.status, [NotificationStatus.Pending, NotificationStatus.Scheduled]),
        ),
      );

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

/**
 * ⚠️ Drizzle/LibSQL rend le compte sous `rowsAffected`, mais le type public ne le promet pas
 * selon le pilote. On lit défensivement, et **l'absence de compte vaut ÉCHEC de prise** : un
 * doute qui accorde la prise enverrait deux fois, un doute qui la refuse ne fait que reporter
 * le rappel à la remise suivante.
 */
function readAffectedRows(result: unknown): number {
  const node = result as { rowsAffected?: unknown; changes?: unknown } | null;
  if (typeof node?.rowsAffected === 'number') return node.rowsAffected;
  if (typeof node?.changes === 'number') return node.changes;
  return 0;
}

import { and, eq, inArray, lt, or } from 'drizzle-orm';
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

  // ⚠️ `Sending` EN FAIT PARTIE : une prise abandonnée est, en fait, en attente. C'est la
  // sélection qui décide ensuite si la grâce est écoulée — sans quoi un rappel dont
  // l'invocation a été tuée serait invisible de toute exécution ultérieure, donc perdu en
  // silence. La prise elle-même, atomique, empêche d'en remettre un qui est réellement en vol.
  async findPending(): Promise<Notification[]> {
    const db = this.resolveDb();
    const result = await db
      .select()
      .from(notifications)
      .where(
        inArray(notifications.status, [
          NotificationStatus.Pending,
          NotificationStatus.Scheduled,
          NotificationStatus.Sending,
        ]),
      );
    return result as Notification[];
  }

  async claimForDispatch(id: string, strandedBefore?: Date): Promise<boolean> {
    const db = this.resolveDb();

    // `Sending` est l'état de PRISE : il n'est écrit que par ce chemin. Un rappel réellement en
    // vol ne peut donc pas être repris — c'est ce qui interdit le doublon.
    //
    // ⚠️ Sauf s'il est ABANDONNÉ : une invocation tuée entre la prise et l'envoi le laisserait
    // dans cet état pour toujours. Au-delà de la grâce, on reprend — un rappel perdu en silence
    // est pire qu'un doublon, qui lui se voit.
    const free = inArray(notifications.status, [
      NotificationStatus.Pending,
      NotificationStatus.Scheduled,
    ]);
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

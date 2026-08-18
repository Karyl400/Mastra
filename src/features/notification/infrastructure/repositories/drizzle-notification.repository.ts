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

  /**
   * Les notifications qu'un ordonnanceur devrait reprendre — s'il en existait un.
   *
   * ⚠️ **DEUX choses à savoir avant de brancher quoi que ce soit dessus.**
   *
   * 1. **Cette méthode n'a AUCUN site d'appel** en production : ni cron, ni poller, ni worker.
   *    C'est assumé et documenté partout dans ce dépôt — `scheduleReminder` rend
   *    explicitement `willBeSentAutomatically: false` plutôt que de laisser croire le
   *    contraire.
   * 2. **Elle filtrait sur le MAUVAIS statut**, et personne ne pouvait s'en apercevoir puisque
   *    rien ne l'appelait : elle cherchait `Pending` alors que `scheduleReminder` écrit
   *    `Scheduled`. Le seul lecteur imaginable était donc déjà incompatible avec le seul
   *    écrivain — un ordonnanceur branché demain aurait tourné à vide, EN SILENCE, et le
   *    diagnostic aurait porté sur le cron plutôt que sur cette ligne.
   *
   * Les deux statuts sont désormais retenus : `Pending` (créée, pas encore traitée) et
   * `Scheduled` (datée par `scheduleReminder`). C'est ce qu'« en attente d'envoi » veut dire.
   */
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

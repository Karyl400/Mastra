import { NotificationStatus } from '../../../../shared/types';
import type { Notification } from '../../domain/entities/notification';
import type { NotificationRepository } from '../../domain/ports/notification.repository';

export class InMemoryNotificationRepository implements NotificationRepository {
  private store = new Map<string, Notification>();

  async findById(id: string): Promise<Notification | null> {
    return this.store.get(id) ?? null;
  }

  async findByRecipient(recipientId: string): Promise<Notification[]> {
    return Array.from(this.store.values()).filter((n) => n.recipientId === recipientId);
  }

  async findPending(): Promise<Notification[]> {
    return Array.from(this.store.values()).filter(
      (n) => n.status === 'pending' || n.status === 'scheduled',
    );
  }

  async save(n: Notification): Promise<void> {
    this.store.set(n.id, n);
  }

  async update(n: Notification): Promise<void> {
    this.store.set(n.id, n);
  }

  // ⚠️ C'est cette doublure qui décide, dans tous les tests du répartiteur, si une seconde
  // exécution remet le rappel une seconde fois. Le contrat est verrouillé sur les DEUX
  // implémentations par la même suite — `tests/unit/notification/notification-claim.test.ts`.
  async claimForDispatch(id: string): Promise<boolean> {
    const current = this.store.get(id);
    if (!current) return false;
    if (
      current.status !== NotificationStatus.Pending &&
      current.status !== NotificationStatus.Scheduled
    ) {
      return false;
    }
    this.store.set(id, { ...current, status: NotificationStatus.Sending });
    return true;
  }

  async releaseClaim(id: string): Promise<void> {
    const current = this.store.get(id);
    if (!current || current.status !== NotificationStatus.Sending) return;
    this.store.set(id, { ...current, status: NotificationStatus.Scheduled });
  }
}

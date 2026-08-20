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
}

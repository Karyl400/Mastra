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
      (n) => n.status === 'pending' || n.status === 'scheduled' || n.status === 'sending',
    );
  }

  async save(n: Notification): Promise<void> {
    this.store.set(n.id, n);
  }

  async update(n: Notification): Promise<void> {
    this.store.set(n.id, n);
  }

  async claimForDispatch(id: string, strandedBefore?: Date): Promise<boolean> {
    const current = this.store.get(id);
    if (!current) return false;

    const free =
      current.status === NotificationStatus.Pending ||
      current.status === NotificationStatus.Scheduled;
    const abandoned =
      strandedBefore !== undefined &&
      current.status === NotificationStatus.Sending &&
      current.updatedAt < strandedBefore.toISOString();

    if (!free && !abandoned) return false;

    this.store.set(id, {
      ...current,
      status: NotificationStatus.Sending,
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  async releaseClaim(id: string): Promise<void> {
    const current = this.store.get(id);
    if (!current || current.status !== NotificationStatus.Sending) return;
    this.store.set(id, { ...current, status: NotificationStatus.Scheduled });
  }
}

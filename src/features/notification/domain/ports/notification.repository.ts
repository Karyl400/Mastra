import type { Notification } from '../entities/notification';

export interface NotificationRepository {
  findById(id: string): Promise<Notification | null>;
  findByRecipient(recipientId: string): Promise<Notification[]>;
  findPending(): Promise<Notification[]>;
  save(notification: Notification): Promise<void>;
  update(notification: Notification): Promise<void>;

  claimForDispatch(id: string, strandedBefore?: Date): Promise<boolean>;

  releaseClaim(id: string): Promise<void>;
}

import { NotificationChannel, NotificationStatus, RecipientType, type Timestamps } from '../../../../shared/types';

export interface Notification extends Timestamps {
  readonly id: string;
  readonly recipientId: string;
  readonly recipientType: RecipientType;
  readonly channel: NotificationChannel;
  readonly subject: string;
  readonly body: string;
  readonly status: NotificationStatus;
  readonly scheduledAt?: string | null;
  readonly sentAt?: string | null;
}

export function createNotification(data: Omit<Notification, keyof Timestamps | 'status'>): Notification {
  const now = new Date().toISOString();
  return {
    ...data,
    status: NotificationStatus.Pending,
    createdAt: now,
    updatedAt: now,
  };
}

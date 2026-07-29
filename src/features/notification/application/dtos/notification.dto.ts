import { z } from 'zod';
import { NotificationChannel, NotificationStatus, RecipientType } from '../../../../shared/types';
import { timestampsSchema, uuidSchema } from '../../../../shared/validation';

export const notificationDtoSchema = z.object({
  id: uuidSchema,
  recipientId: uuidSchema,
  recipientType: z.nativeEnum(RecipientType),
  channel: z.nativeEnum(NotificationChannel),
  subject: z.string().min(1).max(200),
  body: z.string().min(1),
  status: z.nativeEnum(NotificationStatus).default(NotificationStatus.Pending),
  scheduledAt: z.string().datetime().nullable().optional(),
  sentAt: z.string().datetime().nullable().optional(),
}).merge(timestampsSchema);

export type NotificationDto = z.infer<typeof notificationDtoSchema>;

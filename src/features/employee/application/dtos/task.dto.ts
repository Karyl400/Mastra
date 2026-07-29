import { z } from 'zod';
import { TaskStatus, TaskType } from '../../../../shared/types';
import { timestampsSchema, uuidSchema } from '../../../../shared/validation';

export const taskDtoSchema = z.object({
  id: uuidSchema,
  employeeId: uuidSchema,
  title: z.string().min(1).max(200),
  description: z.string().default(''),
  type: z.nativeEnum(TaskType),
  status: z.nativeEnum(TaskStatus).default(TaskStatus.Pending),
  dueDate: z.string().datetime().nullable().optional(),
  assignedTo: z.string().nullable().optional(),
  completedAt: z.string().datetime().nullable().optional(),
}).merge(timestampsSchema);

export type TaskDto = z.infer<typeof taskDtoSchema>;

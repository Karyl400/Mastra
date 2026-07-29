import { z } from 'zod';
import { EmployeeStatus } from '../../../../shared/types';
import { emailSchema, timestampsSchema, uuidSchema } from '../../../../shared/validation';

export const employeeDtoSchema = z.object({
  id: uuidSchema,
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: emailSchema,
  department: z.string().min(1).max(100),
  position: z.string().min(1).max(100),
  startDate: z.string().datetime(),
  status: z.nativeEnum(EmployeeStatus).default(EmployeeStatus.Pending),
  managerId: uuidSchema.nullable().optional(),
}).merge(timestampsSchema);

export type EmployeeDto = z.infer<typeof employeeDtoSchema>;

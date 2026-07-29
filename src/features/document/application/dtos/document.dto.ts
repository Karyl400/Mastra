import { z } from 'zod';
import { DocumentFormat, DocumentStatus, DocumentType } from '../../../../shared/types';
import { timestampsSchema, uuidSchema } from '../../../../shared/validation';

export const documentDtoSchema = z.object({
  id: uuidSchema,
  employeeId: uuidSchema,
  type: z.nativeEnum(DocumentType),
  title: z.string().min(1).max(200),
  content: z.string().default(''),
  format: z.nativeEnum(DocumentFormat).default(DocumentFormat.Txt),
  status: z.nativeEnum(DocumentStatus).default(DocumentStatus.Pending),
  generatedAt: z.string().datetime().nullable().optional(),
}).merge(timestampsSchema);

export type DocumentDto = z.infer<typeof documentDtoSchema>;

import { z } from 'zod';
import { QuestionnaireStatus, ResponseStatus } from '../../../../shared/types';
import { questionSchema, timestampsSchema, uuidSchema } from '../../../../shared/validation';

export const questionnaireDtoSchema = z.object({
  id: uuidSchema,
  title: z.string().min(1).max(200),
  description: z.string().default(''),
  questions: z.array(questionSchema).min(1),
  status: z.nativeEnum(QuestionnaireStatus).default(QuestionnaireStatus.Draft),
}).merge(timestampsSchema);

export type QuestionnaireDto = z.infer<typeof questionnaireDtoSchema>;

export const questionnaireResponseDtoSchema = z.object({
  id: uuidSchema,
  questionnaireId: uuidSchema,
  employeeId: uuidSchema,
  answers: z.record(z.unknown()),
  status: z.nativeEnum(ResponseStatus).default(ResponseStatus.Pending),
  score: z.number().min(0).nullable().optional(),
  reviewedBy: uuidSchema.nullable().optional(),
  submittedAt: z.string().datetime().nullable().optional(),
}).merge(timestampsSchema);

export type QuestionnaireResponseDto = z.infer<typeof questionnaireResponseDtoSchema>;

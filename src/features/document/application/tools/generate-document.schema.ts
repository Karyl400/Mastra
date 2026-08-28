import { z } from 'zod';

import { uuidSchema } from '../../../../shared/validation';
import { DocumentFormat, DocumentType } from '../../../../shared/types';

const RENDERABLE_FORMATS = [DocumentFormat.Pdf, DocumentFormat.Docx] as const;

export const generateDocumentInputSchema = z.object({
  employeeId: uuidSchema.optional().describe('UUID annuaire — omets-le pour le demandeur'),
  type: z.nativeEnum(DocumentType),
  title: z.string().min(1).max(200).describe('rédige-le, ne le demande pas'),
  content: z
    .string()
    .min(1)
    .max(20000)
    .describe(
      'Le texte du document, que TU rédiges toi-même. Ne le demande JAMAIS à la personne : le rédiger EST le travail attendu ici.',
    ),
  format: z.enum(RENDERABLE_FORMATS).optional().default(DocumentFormat.Pdf),
  deliverTo: z.enum(['slack', 'email', 'none']).optional().default('slack'),
  revises: z
    .boolean()
    .optional()
    .describe(
      'true pour CORRIGER le dernier document de ce type déjà produit pour cette personne, au lieu d’en créer un second.',
    ),
});

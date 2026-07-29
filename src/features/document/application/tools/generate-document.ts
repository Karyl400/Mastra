import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { DocumentRepository } from '../../domain/ports/document.repository';
import { createDocument } from '../../domain/entities/document';
import { uuidSchema } from '../../../../shared/validation';
import { logger } from '../../../../shared/logger';
import { DocumentFormat, DocumentType, DocumentStatus } from '../../../../shared/types';

export function makeGenerateDocument(repo: DocumentRepository) {
  return createTool({
    id: 'generateDocument',
    description: 'Génère un document (contrat, lettre d accueil, etc.) pour un employé',
    inputSchema: z.object({
      employeeId: uuidSchema.describe('ID de l employé'),
      type: z.nativeEnum(DocumentType).describe('Type de document'),
      title: z.string().min(1).max(200).describe('Titre du document'),
      content: z.string().min(1).describe('Contenu du document'),
      format: z.nativeEnum(DocumentFormat).optional().default(DocumentFormat.Txt).describe('Format du document'),
    }),
    execute: async (data, _ctx) => {
      logger.info('Génération document', { employeeId: data.employeeId, type: data.type, title: data.title });
      const doc = createDocument({
        id: crypto.randomUUID(),
        employeeId: data.employeeId,
        type: data.type,
        title: data.title,
        content: data.content,
        format: data.format,
      });
      const generated = { ...doc, status: DocumentStatus.Generated, generatedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await repo.save(generated);
      logger.info('Document généré', { id: generated.id });
      return generated;
    },
  });
}

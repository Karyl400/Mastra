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
    // Schéma dépouillé pour le budget de tokens (voir `schedule-reminder.ts`) :
    // les cinq `.describe()` ne faisaient que répéter le nom du champ.
    // `format` est CONSERVÉ malgré son enum coûteux : c'est le seul point
    // d'entrée par lequel un document pourra être demandé en `pdf`.
    // Aucun champ ni aucune règle de validation n'a bougé.
    inputSchema: z.object({
      employeeId: uuidSchema.describe('UUID annuaire'),
      type: z.nativeEnum(DocumentType),
      title: z.string().min(1).max(200),
      content: z.string().min(1),
      format: z.nativeEnum(DocumentFormat).optional().default(DocumentFormat.Txt),
    }),
    execute: async (data, _ctx) => {
      logger.info('Génération document', {
        employeeId: data.employeeId,
        type: data.type,
        title: data.title,
      });
      const doc = createDocument({
        id: crypto.randomUUID(),
        employeeId: data.employeeId,
        type: data.type,
        title: data.title,
        content: data.content,
        format: data.format,
      });
      const generated = {
        ...doc,
        status: DocumentStatus.Generated,
        generatedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await repo.save(generated);
      logger.info('Document généré', { id: generated.id });
      return generated;
    },
  });
}

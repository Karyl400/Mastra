import { Workflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { logger } from '../../../../shared/logger';

const documentInputSchema = z.object({
  employeeId: z.string(),
  documentType: z.string(),
});

const gatherDocumentDataStep = createStep({
  id: 'gatherDocumentData',
  description: 'Récupère les informations de l\'employé nécessaires au document',
  inputSchema: documentInputSchema,
  outputSchema: z.object({
    employeeData: z.record(z.any()),
    templateId: z.string(),
  }),
  execute: async ({ inputData }) => {
    logger.info('Exécution de gatherDocumentDataStep', { inputData });
    return { employeeData: { id: inputData.employeeId }, templateId: `TPL-${inputData.documentType}` };
  }
});

const generatePdfStep = createStep({
  id: 'generatePdf',
  description: 'Génère le PDF final et le stocke ou l\'envoie',
  inputSchema: z.object({
    employeeData: z.record(z.any()),
    templateId: z.string(),
  }),
  outputSchema: z.object({
    documentUrl: z.string(),
    generatedAt: z.string(),
  }),
  execute: async ({ inputData }) => {
    logger.info('Exécution de generatePdfStep', { inputData });
    return { documentUrl: `https://kisso.local/docs/${inputData.templateId}.pdf`, generatedAt: new Date().toISOString() };
  }
});

export const documentGenerationWorkflow = new Workflow({
  id: 'document-generation',
  description: 'Génération automatique de documents administratifs',
  inputSchema: documentInputSchema,
  outputSchema: z.object({
    documentUrl: z.string(),
    generatedAt: z.string(),
  }),
});

documentGenerationWorkflow
  .then(gatherDocumentDataStep)
  .then(generatePdfStep)
  .commit();

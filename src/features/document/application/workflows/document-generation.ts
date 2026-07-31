import { Workflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { logger } from '../../../../shared/logger';
import type { EmployeeRepository } from '../../domain/ports/employee.repository';
import type { PdfService } from '../../domain/ports/pdf.service';

const documentInputSchema = z.object({
  employeeId: z.string().uuid(),
  documentType: z.enum(['contract', 'welcome_letter', 'certificate', 'guide']),
});

const employeeDataSchema = z.object({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().email(),
  department: z.string(),
  position: z.string(),
  startDate: z.string(),
});

export function createDocumentWorkflow(deps: {
  employeeRepo: EmployeeRepository;
  pdfService: PdfService;
}) {
  const gatherDocumentDataStep = createStep({
    id: 'gatherDocumentData',
    inputSchema: documentInputSchema,
    outputSchema: z.object({ employeeData: employeeDataSchema, templateId: z.string() }),
    execute: async ({ inputData }) => {
      logger.info('Gathering employee data', { employeeId: inputData.employeeId });
      const employee = await deps.employeeRepo.findById(inputData.employeeId);
      if (!employee) throw new Error(`Employee ${inputData.employeeId} not found`);
      return {
        employeeData: employee,
        templateId: `TPL-${inputData.documentType}`,
      };
    },
  });

  const generatePdfStep = createStep({
    id: 'generatePdf',
    inputSchema: z.object({
      employeeData: employeeDataSchema,
      templateId: z.string(),
    }),
    outputSchema: z.object({
      documentUrl: z.string().url(),
      generatedAt: z.string().datetime(),
    }),
    execute: async ({ inputData }) => {
      logger.info('Generating PDF', { templateId: inputData.templateId });
      const url = await deps.pdfService.generate(inputData.employeeData, inputData.templateId);
      return { documentUrl: url, generatedAt: new Date().toISOString() };
    },
  });

  const workflow = new Workflow({
    id: 'document-generation',
    inputSchema: documentInputSchema,
    outputSchema: generatePdfStep.outputSchema,
  });

  workflow.then(gatherDocumentDataStep).then(generatePdfStep).commit();
  return workflow;
}
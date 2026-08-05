import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createDocumentWorkflow } from '../../../src/features/document/application/workflows/document-generation';
import type { EmployeeRepository } from '../../../src/features/document/domain/ports/employee.repository';
import type { PdfService } from '../../../src/features/document/domain/ports/pdf.service';

const employeeId = '11111111-1111-4111-8111-111111111111';

const employee = {
  id: employeeId,
  firstName: 'Jean',
  lastName: 'Dupont',
  email: 'jean.dupont@kisso.com',
  department: 'Engineering',
  position: 'Backend Developer',
  startDate: '2026-08-01',
};

describe('Workflow: document-generation', () => {
  let employeeRepo: EmployeeRepository;
  let pdfService: PdfService;

  beforeEach(() => {
    employeeRepo = {
      findById: vi.fn().mockResolvedValue(employee),
    };
    pdfService = {
      generate: vi.fn().mockResolvedValue('./data/documents/welcome_letter_emp.pdf'),
    };
  });

  it('gathers employee data and generates a PDF path', async () => {
    const workflow = createDocumentWorkflow({ employeeRepo, pdfService });
    const run = await workflow.createRun();
    const result = await run.start({
      inputData: { employeeId, documentType: 'welcome_letter' },
    });

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;

    expect(result.result.documentPath).toContain('welcome_letter');
    expect(pdfService.generate).toHaveBeenCalledWith(employee, 'TPL-welcome_letter');
    expect(employeeRepo.findById).toHaveBeenCalledWith(employeeId);
  });

  it('fails when employee does not exist', async () => {
    employeeRepo.findById = vi.fn().mockResolvedValue(null);
    const workflow = createDocumentWorkflow({ employeeRepo, pdfService });
    const run = await workflow.createRun();
    const result = await run.start({
      inputData: { employeeId, documentType: 'contract' },
    });

    expect(result.status).toBe('failed');
    expect(pdfService.generate).not.toHaveBeenCalled();
  });

  it.each(['contract', 'certificate', 'guide'] as const)(
    'maps documentType %s to TPL-%s',
    async (documentType) => {
      const workflow = createDocumentWorkflow({ employeeRepo, pdfService });
      const run = await workflow.createRun();
      const result = await run.start({
        inputData: { employeeId, documentType },
      });

      expect(result.status).toBe('success');
      expect(pdfService.generate).toHaveBeenCalledWith(employee, `TPL-${documentType}`);
    },
  );
});

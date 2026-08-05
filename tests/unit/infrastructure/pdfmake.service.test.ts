import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { PdfmakeService } from '../../../src/features/document/infrastructure/services/pdfmake.service';

const OUTPUT_DIR = join(process.cwd(), 'data', 'test-documents');

const employeeData = {
  id: '11111111-1111-4111-8111-111111111111',
  firstName: 'Jean',
  lastName: 'Dupont',
  email: 'jean.dupont@kisso.com',
  department: 'Engineering',
  position: 'Backend Developer',
  startDate: '2026-08-01',
};

const templates = [
  'TPL-contract',
  'TPL-welcome_letter',
  'TPL-certificate',
  'TPL-guide',
] as const;

describe('Infrastructure: PdfmakeService', () => {
  beforeEach(() => {
    if (existsSync(OUTPUT_DIR)) {
      rmSync(OUTPUT_DIR, { recursive: true, force: true });
    }
    mkdirSync(OUTPUT_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(OUTPUT_DIR)) {
      rmSync(OUTPUT_DIR, { recursive: true, force: true });
    }
  });

  it.each(templates)('generates a valid PDF for %s', async (templateId) => {
    const service = new PdfmakeService(OUTPUT_DIR);
    const filePath = await service.generate(employeeData, templateId);

    expect(existsSync(filePath)).toBe(true);
    expect(filePath).toContain(templateId.replace('TPL-', ''));

    const buffer = readFileSync(filePath);
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buffer.length).toBeGreaterThan(500);
  });

  it('throws on unknown template', async () => {
    const service = new PdfmakeService(OUTPUT_DIR);
    await expect(service.generate(employeeData, 'TPL-unknown')).rejects.toThrow(/Unknown template/);
  });
});

import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { PdfmakeService } from '../../../src/features/document/infrastructure/services/pdfmake.service';
import { DocxService } from '../../../src/features/document/infrastructure/services/docx.service';
import type { DocumentRenderInput } from '../../../src/features/document/domain/ports/document-renderer';
import { DocumentFormat, DocumentType } from '../../../src/shared/types';

/**
 * Ces tests vivent sous `tests/unit/infrastructure-services/` et NON sous
 * `tests/unit/infrastructure/` : ce dernier est exclu du run unitaire par
 * `vitest.config.ts` et rattaché à l'intégration. Y poser ces tests reviendrait
 * à ne jamais les exécuter dans `npm run test:unit`.
 */

const OUTPUT_DIR = join(process.cwd(), 'data', 'test-render-documents');

const employee = {
  firstName: 'Jean',
  lastName: 'Dupont',
  email: 'jean.dupont@kisso.com',
  department: 'Engineering',
  position: 'Backend Developer',
  startDate: '2026-08-01',
};

function inputFor(type: DocumentType, overrides: Partial<DocumentRenderInput> = {}) {
  return {
    type,
    title: 'Guide onboarding Jean',
    content: 'Premier paragraphe.\n\nSecond paragraphe, plus long.\n\nTroisième.',
    employee,
    ...overrides,
  } satisfies DocumentRenderInput;
}

/** Un PDF commence toujours par `%PDF-`. */
function isPdf(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-';
}

/** Un DOCX est un ZIP : signature locale `PK\x03\x04`. */
function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

afterAll(() => {
  if (existsSync(OUTPUT_DIR)) rmSync(OUTPUT_DIR, { recursive: true, force: true });
});

describe('Infrastructure : PdfmakeService en tant que DocumentRenderer', () => {
  const service = new PdfmakeService(OUTPUT_DIR);

  it('annonce le format PDF', () => {
    expect(service.format).toBe(DocumentFormat.Pdf);
  });

  it.each([
    DocumentType.Contract,
    DocumentType.WelcomeLetter,
    DocumentType.Certificate,
    DocumentType.Guide,
  ])('produit un vrai PDF pour un type doté d’un template dédié (%s)', async (type) => {
    const rendered = await service.render(inputFor(type));

    expect(isPdf(rendered.bytes)).toBe(true);
    expect(rendered.bytes.length).toBeGreaterThan(500);
    expect(rendered.mimeType).toBe('application/pdf');
    expect(rendered.filename).toBe('guide-onboarding-jean.pdf');
  });

  it.each([
    DocumentType.Amendment,
    DocumentType.Policy,
    DocumentType.TaxForm,
    DocumentType.IDDocument,
    DocumentType.Other,
  ])('rend le template générique pour un type sans template dédié (%s)', async (type) => {
    const rendered = await service.render(inputFor(type, { title: 'Note interne' }));

    expect(isPdf(rendered.bytes)).toBe(true);
    expect(rendered.filename).toBe('note-interne.pdf');
  });

  it('n’écrit rien sur le disque en rendu pur', async () => {
    await service.render(inputFor(DocumentType.Other));
    expect(existsSync(OUTPUT_DIR)).toBe(false);
  });

  it('conserve `generate()` — l’ancien port PdfService écrit toujours sur disque', async () => {
    const filepath = await service.generate(employee, 'TPL-welcome_letter');

    expect(existsSync(filepath)).toBe(true);
    expect(filepath).toContain('welcome_letter');

    const buffer = readFileSync(filepath);
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buffer.length).toBeGreaterThan(500);
  });

  it('rejette toujours un templateId inconnu', async () => {
    await expect(service.generate(employee, 'TPL-unknown')).rejects.toThrow(/Unknown template/);
  });
});

describe('Infrastructure : DocxService', () => {
  const service = new DocxService();

  it('annonce le format DOCX', () => {
    expect(service.format).toBe(DocumentFormat.Docx);
  });

  it.each([
    DocumentType.Contract,
    DocumentType.WelcomeLetter,
    DocumentType.Certificate,
    DocumentType.Guide,
  ])('produit un vrai DOCX pour un type doté d’un template dédié (%s)', async (type) => {
    const rendered = await service.render(inputFor(type));

    expect(isZip(rendered.bytes)).toBe(true);
    expect(rendered.bytes.length).toBeGreaterThan(500);
    expect(rendered.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(rendered.filename).toBe('guide-onboarding-jean.docx');
  });

  it.each([
    DocumentType.Amendment,
    DocumentType.Policy,
    DocumentType.TaxForm,
    DocumentType.IDDocument,
    DocumentType.Other,
  ])('rend le template générique pour un type sans template dédié (%s)', async (type) => {
    const rendered = await service.render(inputFor(type, { title: 'Note interne' }));

    expect(isZip(rendered.bytes)).toBe(true);
    expect(rendered.filename).toBe('note-interne.docx');
  });

  it('tolère un employé absent et un contenu vide', async () => {
    const rendered = await service.render({
      type: DocumentType.Certificate,
      title: 'Certificat',
      content: '',
    });

    expect(isZip(rendered.bytes)).toBe(true);
  });
});

describe('Parité PDF / DOCX — le format est un choix de rendu, jamais de contenu', () => {
  it('les deux renderers acceptent exactement la même entrée pour tous les types', async () => {
    const pdf = new PdfmakeService(OUTPUT_DIR);
    const docx = new DocxService();

    for (const type of Object.values(DocumentType)) {
      const input = inputFor(type);
      const [a, b] = await Promise.all([pdf.render(input), docx.render(input)]);

      expect(isPdf(a.bytes)).toBe(true);
      expect(isZip(b.bytes)).toBe(true);
      // Même base de nom, seule l'extension distingue les deux sorties.
      expect(a.filename.replace(/\.pdf$/, '')).toBe(b.filename.replace(/\.docx$/, ''));
    }
  });
});

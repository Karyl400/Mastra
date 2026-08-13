import { describe, expect, it } from 'vitest';
import { createEmployee } from '../../../src/features/employee/domain/entities/employee';
import { buildDocumentOutline } from '../../../src/features/document/domain/services/document-template';
import { DocumentType } from '../../../src/shared/types';

/**
 * Le département a cessé d'être collecté le 2026-08-13 : la modale d'arrivée ne pose plus
 * qu'une question, le poste.
 *
 * Ces tests verrouillent les deux propriétés qui comptent — l'absence est REPRÉSENTABLE, et
 * elle ne se voit nulle part dans un livrable. Un document signé de l'entreprise qui
 * imprimerait « Département : N/A » serait pire que le champ manquant : il transformerait une
 * décision en oubli visible par l'arrivant.
 */
describe('département facultatif', () => {
  it('accepte un employé sans département', () => {
    const employee = createEmployee({
      id: 'e1',
      firstName: 'Léa',
      lastName: 'Bamba',
      email: 'lea@kisso.com',
      department: null,
      position: 'Software Engineer',
      startDate: '2026-08-13T00:00:00.000Z',
      managerId: null,
    });

    expect(employee.department).toBeNull();
  });

  const WITHOUT_DEPARTMENT = {
    firstName: 'Léa',
    lastName: 'Bamba',
    email: 'lea@kisso.com',
    position: 'Software Engineer',
    startDate: '2026-08-13',
  };

  for (const type of [DocumentType.Contract, DocumentType.WelcomeLetter, DocumentType.Guide]) {
    it(`n'imprime aucun département de remplissage dans un ${type}`, () => {
      const rendered = JSON.stringify(
        buildDocumentOutline({
          type,
          title: 'Document',
          content: 'Bonjour',
          employee: WITHOUT_DEPARTMENT,
        }),
      );

      expect(rendered).not.toContain('Département');
      expect(rendered).not.toContain('département');
      expect(rendered).not.toContain('N/A');
      expect(rendered).not.toContain('Général');
      expect(rendered).not.toContain('null');
    });
  }

  it('imprime bien le département quand il est connu', () => {
    const rendered = JSON.stringify(
      buildDocumentOutline({
        type: DocumentType.Contract,
        title: 'Contrat',
        content: 'Bonjour',
        employee: { ...WITHOUT_DEPARTMENT, department: 'Engineering' },
      }),
    );

    expect(rendered).toContain('Département');
    expect(rendered).toContain('Engineering');
  });
});

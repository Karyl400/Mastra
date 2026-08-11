import { describe, it, expect } from 'vitest';

import {
  buildDocumentFilename,
  documentMimeType,
  FALLBACK_DOCUMENT_BASENAME,
} from '../../../src/features/document/domain/services/document-file';
import { DocumentFormat } from '../../../src/shared/types';

/**
 * Le `filename` produit ici part chez Slack (`files.uploadV2`) et en pièce jointe
 * email : il sort du processus. Tout ce qui suit est donc une contrainte de
 * sûreté, pas de confort — un séparateur de chemin ou une chaîne vide qui
 * passerait ici deviendrait un nom de fichier hostile chez le destinataire.
 */
describe('Domaine : nom de fichier et type MIME d’un document rendu', () => {
  it('translittère les accents et remplace les espaces', () => {
    expect(buildDocumentFilename('Lettre de bienvenue — Émilie Dupré', DocumentFormat.Pdf)).toBe(
      'lettre-de-bienvenue-emilie-dupre.pdf',
    );
  });

  it('neutralise les séparateurs de chemin et la traversée de répertoire', () => {
    const filename = buildDocumentFilename('../../etc/passwd', DocumentFormat.Docx);

    expect(filename).not.toContain('/');
    expect(filename).not.toContain('\\');
    expect(filename).not.toContain('..');
    expect(filename).toBe('etc-passwd.docx');
  });

  it('retombe sur un nom déterministe quand le titre est vide', () => {
    expect(buildDocumentFilename('', DocumentFormat.Pdf)).toBe(`${FALLBACK_DOCUMENT_BASENAME}.pdf`);
  });

  it('retombe sur un nom déterministe quand le titre est entièrement filtré', () => {
    // Un titre composé uniquement de caractères rejetés ne doit JAMAIS produire
    // une extension orpheline (« .pdf »), qui est un fichier caché sous Unix.
    expect(buildDocumentFilename('/// *** ///', DocumentFormat.Docx)).toBe(
      `${FALLBACK_DOCUMENT_BASENAME}.docx`,
    );
  });

  it('borne la longueur du nom', () => {
    const filename = buildDocumentFilename('A'.repeat(500), DocumentFormat.Pdf);

    expect(filename.length).toBeLessThanOrEqual(84);
    expect(filename.endsWith('.pdf')).toBe(true);
    expect(filename.startsWith('-')).toBe(false);
    expect(filename).not.toContain('-.');
  });

  it('expose les types MIME attendus par Slack et par les clients mail', () => {
    expect(documentMimeType(DocumentFormat.Pdf)).toBe('application/pdf');
    expect(documentMimeType(DocumentFormat.Docx)).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });
});

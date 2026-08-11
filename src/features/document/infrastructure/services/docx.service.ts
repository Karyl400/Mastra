import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';

import type {
  DocumentRenderInput,
  DocumentRenderer,
  RenderedDocument,
} from '../../domain/ports/document-renderer';
import { buildDocumentFilename, documentMimeType } from '../../domain/services/document-file';
import { buildDocumentOutline, type DocumentBlock } from '../../domain/services/document-template';
import { DocumentFormat } from '../../../../shared/types';
import { logger } from '../../../../shared/logger';

/**
 * Rend un document en DOCX (Office Open XML).
 *
 * L'import est STATIQUE, contrairement au `createRequire` de `pdfmake.service.ts` :
 * l'analyse statique du bundler Mastra/Vercel le voit, `docx` et ses dépendances
 * sont donc embarqués sans passer par le rattrapage de `fix-vercel-output.js`.
 * C'est précisément l'invisibilité du `require()` dynamique qui avait produit le
 * `Cannot find module 'js-md5'` en production sur la chaîne PDF — on ne reproduit
 * pas ce montage ici.
 *
 * ⚠️ VÉRIFIÉ, mais conditionné au câblage : tant qu'aucun module atteignable
 * depuis `src/mastra/index.ts` n'importe ce fichier, `docx` n'entre PAS dans le
 * bundle (constaté sur un `npm run build` réel). Dès que le service est câblé, le
 * bundler embarque `docx@9.7.1` et ses cinq dépendances (`hash.js`, `jszip`,
 * `nanoid`, `xml`, `xml-js`), audit du bundle au vert. C'est à ce moment-là — et
 * pas avant, sinon le build casse — qu'il faut ajouter `docx` au garde-fou
 * `verify:bundle` de `package.json` (`--require pdfkit,pdfmake,js-md5,fontkit,docx`).
 *
 * Aucune écriture disque : le service rend des octets, seul chemin utilisable sur
 * Vercel (FS en lecture seule hors `/tmp`, et éphémère).
 */
export class DocxService implements DocumentRenderer {
  readonly format = DocumentFormat.Docx;

  async render(input: DocumentRenderInput): Promise<RenderedDocument> {
    const outline = buildDocumentOutline(input);

    const document = new Document({
      sections: [{ properties: {}, children: outline.blocks.flatMap(renderBlock) }],
    });

    const bytes = await Packer.toBuffer(document);

    // Le titre ASSAINI de l'outline, jamais `input.title` : le nom de fichier part
    // dans Slack et en pièce jointe email (voir `pdfmake.service.ts`).
    const filename = buildDocumentFilename(outline.title, DocumentFormat.Docx);

    logger.info('DOCX generated', { filename, type: input.type, size: bytes.length });

    return { bytes, filename, mimeType: documentMimeType(DocumentFormat.Docx) };
  }
}

/**
 * Traduit un bloc du modèle logique en paragraphes Word.
 *
 * Un bloc `fields` devient une suite de paragraphes « **Libellé :** valeur »
 * plutôt qu'un tableau Word : le tableau n'apporterait rien à la lecture d'un
 * couple clé/valeur, et il ajouterait `Table`/`TableRow`/`TableCell` à la surface
 * d'API utilisée — donc autant de façons de casser au prochain bump de `docx`.
 */
function renderBlock(block: DocumentBlock): Paragraph[] {
  switch (block.kind) {
    case 'heading':
      return [
        new Paragraph({
          heading: block.level === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2,
          children: [new TextRun({ text: block.text, bold: true })],
        }),
      ];

    case 'paragraph':
      return [
        new Paragraph({
          children: [new TextRun({ text: block.text, italics: block.italic === true })],
        }),
      ];

    case 'bullets':
      return block.items.map((item) => new Paragraph({ text: item, bullet: { level: 0 } }));

    case 'fields':
      return block.rows.map(
        (row) =>
          new Paragraph({
            children: [
              new TextRun({ text: `${row[0]} : `, bold: true }),
              new TextRun({ text: row[1] }),
            ],
          }),
      );
  }
}

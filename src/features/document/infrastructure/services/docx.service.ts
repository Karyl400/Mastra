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

export class DocxService implements DocumentRenderer {
  readonly format = DocumentFormat.Docx;

  async render(input: DocumentRenderInput): Promise<RenderedDocument> {
    const outline = buildDocumentOutline(input);

    const document = new Document({
      sections: [{ properties: {}, children: outline.blocks.flatMap(renderBlock) }],
    });

    const bytes = await Packer.toBuffer(document);

    const filename = buildDocumentFilename(outline.title, DocumentFormat.Docx);

    logger.info('DOCX generated', { filename, type: input.type, size: bytes.length });

    return { bytes, filename, mimeType: documentMimeType(DocumentFormat.Docx) };
  }
}

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

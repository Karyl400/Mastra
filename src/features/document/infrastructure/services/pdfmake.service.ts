import { createRequire } from 'module';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';

import type {
  DocumentRenderInput,
  DocumentRenderer,
  RenderedDocument,
} from '../../domain/ports/document-renderer';
import { buildDocumentFilename, documentMimeType } from '../../domain/services/document-file';
import {
  buildDocumentOutline,
  type DocumentBlock,
  type DocumentOutline,
} from '../../domain/services/document-template';
import { DocumentFormat } from '../../../../shared/types';
import { logger } from '../../../../shared/logger';
import { toPrintableText, type GlyphSource } from '../../domain/services/printable-text';

const _require = createRequire(import.meta.url);

type PdfMakeInstance = {
  setUrlAccessPolicy: (cb: () => boolean) => void;
  setLocalAccessPolicy: (cb: () => boolean) => void;

  addFonts: (fonts: Record<string, Record<string, string>>) => void;

  virtualfs: {
    writeFileSync(name: string, data: Buffer): void;
  };

  createPdf(doc: TDocumentDefinitions): {
    getBuffer(): Promise<Buffer>;
  };
};

type RobotoModule = {
  fonts: Record<string, Record<string, string>>;

  vfs: Record<
    string,
    | string
    | {
        data: string;
        encoding?: BufferEncoding;
      }
  >;
};

let pdfmake: PdfMakeInstance | null = null;
let Roboto: RobotoModule | null = null;

function loadPdfMake(): void {
  if (pdfmake && Roboto) {
    return;
  }

  pdfmake = _require('pdfmake') as PdfMakeInstance;

  Roboto = _require('pdfmake/build/fonts/Roboto.js') as RobotoModule;
}

let fontsInitialized = false;

function ensureFonts(): void {
  loadPdfMake();

  if (fontsInitialized) {
    return;
  }

  if (!pdfmake || !Roboto) {
    throw new Error('PDFMake initialization failed');
  }

  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy(() => false);

  for (const [name, entry] of Object.entries(Roboto.vfs)) {
    const data = typeof entry === 'string' ? entry : entry.data;

    const encoding = typeof entry === 'string' ? 'base64' : (entry.encoding ?? 'base64');

    pdfmake.virtualfs.writeFileSync(name, Buffer.from(data, encoding));
  }

  pdfmake.addFonts(Roboto.fonts);

  fontsInitialized = true;
}

const STYLES: TDocumentDefinitions['styles'] = {
  header: { fontSize: 20, bold: true, margin: [0, 0, 0, 8] },
  subheader: { fontSize: 14, bold: true, margin: [0, 10, 0, 6] },
  body: { fontSize: 11, margin: [0, 0, 0, 6] },
};

let glyphs: GlyphSource | null = null;

function glyphSource(): GlyphSource {
  if (glyphs) return glyphs;

  const known = new Map<number, boolean>();
  let font: { hasGlyphForCodePoint(cp: number): boolean } | null = null;

  try {
    const fontkit = _require('fontkit') as { create(buffer: Buffer): typeof font };
    const entry = Roboto?.vfs['Roboto-Regular.ttf'];
    const base64 = typeof entry === 'string' ? entry : entry?.data;
    if (base64) font = fontkit.create(Buffer.from(base64, 'base64'));
  } catch (error) {
    logger.warn('Police illisible — filtre de glyphes désactivé pour ce processus', { error });
  }

  glyphs = {
    hasGlyph(codePoint: number): boolean {
      if (!font) return true;
      const cached = known.get(codePoint);
      if (cached !== undefined) return cached;
      const has = font.hasGlyphForCodePoint(codePoint);
      known.set(codePoint, has);
      return has;
    },
  };

  return glyphs;
}

function printable(text: string, replaced: Set<string>): string {
  const result = toPrintableText(text, glyphSource());
  for (const cp of result.replaced) replaced.add(cp);
  return result.text;
}

function renderBlock(block: DocumentBlock, replaced: Set<string>): Content {
  const p = (text: string) => printable(text, replaced);

  switch (block.kind) {
    case 'heading':
      return { text: p(block.text), style: block.level === 1 ? 'header' : 'subheader' };

    case 'paragraph':
      return { text: p(block.text), style: 'body', italics: block.italic === true };

    case 'bullets':
      return { ul: block.items.map(p), style: 'body' };

    case 'fields':
      return {
        table: { widths: ['*', '*'], body: block.rows.map((row) => [p(row[0]), p(row[1])]) },
        margin: [0, 6, 0, 6],
      };
  }
}

function toDocumentDefinition(outline: DocumentOutline): TDocumentDefinitions {
  const replaced = new Set<string>();
  const content = outline.blocks.map((block) => renderBlock(block, replaced));

  if (replaced.size > 0) {
    logger.info('Caractères sans glyphe remplacés au rendu PDF', {
      codePoints: [...replaced],
    });
  }

  return {
    content,
    styles: STYLES,
    defaultStyle: { font: 'Roboto' },
  };
}

export class PdfmakeService implements DocumentRenderer {
  readonly format = DocumentFormat.Pdf;

  async render(input: DocumentRenderInput): Promise<RenderedDocument> {
    const outline = buildDocumentOutline(input);
    const bytes = await this.renderBytes(outline);

    return {
      bytes,
      filename: buildDocumentFilename(outline.title, DocumentFormat.Pdf),
      mimeType: documentMimeType(DocumentFormat.Pdf),
    };
  }

  private async renderBytes(outline: DocumentOutline): Promise<Uint8Array> {
    ensureFonts();

    if (!pdfmake) {
      throw new Error('PDFMake unavailable');
    }

    return await pdfmake.createPdf(toDocumentDefinition(outline)).getBuffer();
  }
}

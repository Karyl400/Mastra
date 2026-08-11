import { createRequire } from 'module';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';

import type { PdfService } from '../../domain/ports/pdf.service';
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
import { DocumentFormat, DocumentType } from '../../../../shared/types';
import { logger } from '../../../../shared/logger';

const _require = createRequire(import.meta.url);

// ─────────────────────────────────────────────
// Types pdfmake
// ─────────────────────────────────────────────

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

// ─────────────────────────────────────────────
// Lazy loading Vercel compatible
// ─────────────────────────────────────────────

let pdfmake: PdfMakeInstance | null = null;
let Roboto: RobotoModule | null = null;

function loadPdfMake(): void {
  if (pdfmake && Roboto) {
    return;
  }

  pdfmake = _require('pdfmake') as PdfMakeInstance;

  Roboto = _require('pdfmake/build/fonts/Roboto.js') as RobotoModule;
}

// ─────────────────────────────────────────────
// Fonts initialization
// ─────────────────────────────────────────────

let fontsInitialized = false;

function ensureFonts(): void {
  loadPdfMake();

  if (fontsInitialized) {
    return;
  }

  if (!pdfmake || !Roboto) {
    throw new Error('PDFMake initialization failed');
  }

  // Sécurité :
  // empêche pdfmake de charger des ressources externes
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

// ─────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────

/**
 * Anciens identifiants de template, conservés pour `documentGenerationWorkflow`
 * qui les passe encore en clair. Ils ne sont plus qu'un alias vers un
 * `DocumentType` : le contenu réel vit désormais dans
 * `domain/services/document-template.ts`, partagé avec le rendu DOCX.
 */
type TemplateId = 'TPL-contract' | 'TPL-welcome_letter' | 'TPL-certificate' | 'TPL-guide';

const TEMPLATE_TYPES: Record<TemplateId, DocumentType> = {
  'TPL-contract': DocumentType.Contract,
  'TPL-welcome_letter': DocumentType.WelcomeLetter,
  'TPL-certificate': DocumentType.Certificate,
  'TPL-guide': DocumentType.Guide,
};

/** Champ employé lu depuis un enregistrement non typé (`generate()`). */
function readField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

// ─────────────────────────────────────────────
// Traduction du modèle logique vers pdfmake
// ─────────────────────────────────────────────

const STYLES: TDocumentDefinitions['styles'] = {
  header: { fontSize: 20, bold: true, margin: [0, 0, 0, 8] },
  subheader: { fontSize: 14, bold: true, margin: [0, 10, 0, 6] },
  body: { fontSize: 11, margin: [0, 0, 0, 6] },
};

function renderBlock(block: DocumentBlock): Content {
  switch (block.kind) {
    case 'heading':
      return { text: block.text, style: block.level === 1 ? 'header' : 'subheader' };

    case 'paragraph':
      return { text: block.text, style: 'body', italics: block.italic === true };

    case 'bullets':
      return { ul: [...block.items], style: 'body' };

    case 'fields':
      return {
        table: { widths: ['*', '*'], body: block.rows.map((row) => [row[0], row[1]]) },
        margin: [0, 6, 0, 6],
      };
  }
}

function toDocumentDefinition(outline: DocumentOutline): TDocumentDefinitions {
  return {
    content: outline.blocks.map(renderBlock),
    styles: STYLES,
    // Roboto est la seule police injectée dans le VFS : tout autre nom ferait
    // échouer le rendu au lieu de dégrader.
    defaultStyle: { font: 'Roboto' },
  };
}

// ─────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────

/**
 * Rend un document en PDF.
 *
 * Deux ports, une seule mécanique de rendu :
 * - `DocumentRenderer.render()` — chemin PUR, rend des octets. C'est le seul
 *   utilisable sur Vercel, dont le système de fichiers est en lecture seule hors
 *   `/tmp` et éphémère.
 * - `PdfService.generate()` — chemin historique, écrit sur disque et rend un
 *   chemin local. Conservé tel quel pour `documentGenerationWorkflow`, mais il
 *   délègue désormais au rendu pur : un seul endroit produit le PDF.
 */
export class PdfmakeService implements PdfService, DocumentRenderer {
  readonly format = DocumentFormat.Pdf;

  private outputDir: string;

  constructor(outputDir = './data/documents') {
    this.outputDir = outputDir;
  }

  async render(input: DocumentRenderInput): Promise<RenderedDocument> {
    const bytes = await this.renderBytes(buildDocumentOutline(input));

    return {
      bytes,
      filename: buildDocumentFilename(input.title, DocumentFormat.Pdf),
      mimeType: documentMimeType(DocumentFormat.Pdf),
    };
  }

  async generate(employeeData: Record<string, unknown>, templateId: string): Promise<string> {
    const type = TEMPLATE_TYPES[templateId as TemplateId];

    if (!type) {
      throw new Error(`Unknown template ${templateId}`);
    }

    const outline = buildDocumentOutline({
      type,
      // Le workflow ne fournit ni titre ni corps : le template s'appuie alors sur
      // son titre par défaut et sur les seules données employé.
      title: '',
      content: '',
      employee: {
        firstName: readField(employeeData, 'firstName'),
        lastName: readField(employeeData, 'lastName'),
        email: readField(employeeData, 'email'),
        department: readField(employeeData, 'department'),
        position: readField(employeeData, 'position'),
        startDate: readField(employeeData, 'startDate'),
      },
    });

    const buffer = await this.renderBytes(outline);

    if (!existsSync(this.outputDir)) {
      mkdirSync(this.outputDir, {
        recursive: true,
      });
    }

    // Nom historique : `documentGenerationWorkflow` et ses tests s'appuient sur la
    // présence du templateId dans le chemin rendu.
    const filename = `${templateId}_${Date.now()}.pdf`;

    const filepath = join(this.outputDir, filename);

    writeFileSync(filepath, buffer);

    logger.info('PDF generated', {
      filepath,
      templateId,
      size: buffer.length,
    });

    return filepath;
  }

  private async renderBytes(outline: DocumentOutline): Promise<Uint8Array> {
    ensureFonts();

    if (!pdfmake) {
      throw new Error('PDFMake unavailable');
    }

    return await pdfmake.createPdf(toDocumentDefinition(outline)).getBuffer();
  }
}

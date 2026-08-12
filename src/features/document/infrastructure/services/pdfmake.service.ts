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
 * UN SEUL chemin depuis le 2026-08-12 : `DocumentRenderer.render()`, qui rend des OCTETS et
 * ne touche jamais le disque.
 *
 * L'ancien `PdfService.generate()` écrivait un fichier et rendait un chemin local. Il
 * n'existait que pour `documentGenerationWorkflow`, son unique appelant — un workflow supprimé
 * parce qu'il était inutilisable en production : le système de fichiers de Vercel est en
 * LECTURE SEULE hors `/tmp`, et `/tmp` est éphémère et propre à l'instance, donc le chemin
 * rendu ne désignait rien que quiconque puisse lire. Le port `PdfService` a disparu avec lui.
 *
 * Ce qu'il faut retenir si l'envie revient d'écrire sur disque : sur cette plateforme, un
 * chemin de fichier n'est pas une livraison. La livraison, c'est l'upload Slack ou la pièce
 * jointe email, tous deux alimentés par les octets de `render()`.
 */
export class PdfmakeService implements DocumentRenderer {
  readonly format = DocumentFormat.Pdf;

  async render(input: DocumentRenderInput): Promise<RenderedDocument> {
    const outline = buildDocumentOutline(input);
    const bytes = await this.renderBytes(outline);

    return {
      bytes,
      // Le nom vient du titre ASSAINI de l'outline, jamais de `input.title`. La
      // translittération de `buildDocumentFilename` ne protège que la FORME du nom :
      // un titre `Guide [SECURITY_BLOCK]` en sortait `guide-security-block.pdf`, et ce
      // nom part dans Slack et en pièce jointe email — un canal de fuite de plus.
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

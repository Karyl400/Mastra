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

/**
 * La police, interrogée sur ce qu'elle sait écrire.
 *
 * ⚠️ Construite UNE FOIS et mémorisée par code point : `hasGlyphForCodePoint` parcourt les
 * tables de correspondance de la police, et ce rendu est appelé sur chaque feuille de chaque
 * bloc. Sans mémoire, un document d'une page reposerait la même question des milliers de fois.
 *
 * ⚠️ Elle échoue OUVERT : si la police ne peut pas être interrogée (fontkit absent du bundle,
 * TTF illisible), on répond « oui » à tout et l'on retombe exactement sur le comportement
 * d'avant ce correctif — des carrés possibles, jamais un rendu perdu. Un document livré avec
 * une flèche imparfaite vaut mieux qu'une génération qui échoue.
 */
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

/**
 * Texte prêt à imprimer, et ce qui a dû être remplacé pour cela.
 *
 * Les code points traités sont ACCUMULÉS dans le tableau passé, puis journalisés une seule
 * fois par document : une ligne par caractère ferait du bruit sur un texte qui en contient
 * cinquante, et c'est le RÉPERTOIRE qui nous intéresse, pas le nombre d'occurrences.
 */
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
  // ⚠️ LE FILTRE EST POSÉ ICI, dans le renderer PDF, et NULLE PART AILLEURS.
  //
  // C'est une limitation de ROBOTO, pas du produit : Word embarque des polices complètes, et
  // un DOCX rend parfaitement `→` et l'espace fine insécable. Poser ce filtre dans le domaine
  // partagé appauvrirait le DOCX pour un défaut qui ne le concerne pas — et le dépôt a déjà
  // écrit ce raisonnement à l'envers pour les emojis, retirés en amont parce qu'AUCUN des
  // deux formats ne les rendait correctement dans un document d'entreprise.
  const replaced = new Set<string>();
  const content = outline.blocks.map((block) => renderBlock(block, replaced));

  if (replaced.size > 0) {
    // `info` et non `warn` : ce n'est pas une anomalie, c'est le filtre qui fait son travail.
    // Mais c'est la ligne qui dit ce que le modèle écrit RÉELLEMENT — et le seul moyen
    // d'apprendre qu'un caractère nouveau circule avant qu'un humain ne le voie en carré.
    logger.info('Caractères sans glyphe remplacés au rendu PDF', {
      codePoints: [...replaced],
    });
  }

  return {
    content,
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

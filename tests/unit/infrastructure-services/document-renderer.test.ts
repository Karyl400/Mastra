import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join } from 'node:path';
import JSZip from 'jszip';

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
  const service = new PdfmakeService();

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
    const pdf = new PdfmakeService();
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

// ─────────────────────────────────────────────────────────────────────────────
// Preuve PAR LES OCTETS
// ─────────────────────────────────────────────────────────────────────────────
//
// Vérifier l'ENTRÉE du renderer ne prouve rien : c'est exactement ce que faisait
// la campagne qui a laissé passer le défaut. Ces helpers relisent le fichier
// RÉELLEMENT produit.
//
// Pour le PDF, pdfmake encode le texte en identifiants de glyphes d'une sous-police
// Roboto embarquée : chercher « SECURITY_BLOCK » dans les octets ne trouverait
// jamais rien, même quand la chaîne est bel et bien imprimée. On décompresse donc
// les flux, on décode la CMap `ToUnicode` de chaque police (glyphe → Unicode) et on
// reconstruit le texte des opérateurs `TJ`/`Tj`. C'est la seule lecture qui dise ce
// que le lecteur verra — et c'est elle qui a montré que les emojis sortaient en
// glyphe 0, le `.notdef` (le « carré » signalé par le propriétaire).

/** Glyphe 0 d'une sous-police : `.notdef`, le carré affiché faute de dessin. */
const NOTDEF = String.fromCharCode(0);

/**
 * Objets PDF indirects, flux décompressés quand ils le sont.
 *
 * Le balayage avance derrière chaque objet, et la longueur d'un flux est lue dans
 * son `/Length` — jamais cherchée par `indexOf('endobj')`. Les flux de police
 * embarquée sont du binaire de plusieurs kilo-octets : ils contiennent des
 * séquences `endobj` fortuites, qui tronquaient l'objet courant et décalaient tout
 * le reste du balayage. Symptôme observé : un paragraphe décodé avec la CMap de la
 * MAUVAISE police, donc un faux négatif potentiel sur ces tests de sécurité.
 */
function readPdfObjects(bytes: Uint8Array): Map<number, string> {
  const buf = Buffer.from(bytes);
  const latin = buf.toString('latin1');
  const objects = new Map<number, string>();
  const header = /(\d+)\s+0\s+obj/g;

  let cursor = 0;
  for (;;) {
    header.lastIndex = cursor;
    const match = header.exec(latin);
    if (!match) break;

    const bodyStart = match.index + match[0].length;
    const streamAt = latin.indexOf('stream', bodyStart);
    const objEnd = latin.indexOf('endobj', bodyStart);

    if (streamAt === -1 || (objEnd !== -1 && objEnd < streamAt)) {
      objects.set(Number(match[1]), latin.slice(bodyStart, objEnd === -1 ? undefined : objEnd));
      cursor = objEnd === -1 ? latin.length : objEnd + 'endobj'.length;
      continue;
    }

    const dict = latin.slice(bodyStart, streamAt);
    const length = Number(/\/Length\s+(\d+)/.exec(dict)?.[1] ?? 0);

    let start = streamAt + 'stream'.length;
    if (latin[start] === '\r') start += 1;
    if (latin[start] === '\n') start += 1;

    let data = '';
    try {
      data = inflateSync(buf.subarray(start, start + length)).toString('latin1');
    } catch {
      data = '';
    }

    objects.set(Number(match[1]), `${dict}\n${data}`);
    cursor = start + length;
  }

  return objects;
}

/**
 * CMap `ToUnicode` : identifiant de glyphe → caractère(s).
 *
 * ⚠️ Une entrée peut porter PLUSIEURS points de code séparés par une espace —
 * `<0066 0069>` est la ligature « fi », que Roboto substitue dans « Configurer ».
 * Un motif qui n'accepterait que des chiffres hexadécimaux sauterait cette entrée
 * et DÉCALERAIT toutes les suivantes : le texte extrait devient une permutation
 * plausible, donc un faux négatif silencieux sur les motifs interdits.
 */
function parseToUnicode(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  const decode = (hex: string) =>
    (hex.replace(/\s+/g, '').match(/.{4}/g) ?? [])
      .map((unit) => String.fromCharCode(parseInt(unit, 16)))
      .join('');

  for (const block of cmap.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    for (const pair of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F\s]+?)>/g)) {
      map.set(parseInt(pair[1]!, 16), decode(pair[2]!));
    }
  }

  for (const block of cmap.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
    for (const range of block.matchAll(
      /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:\[([\s\S]*?)\]|<([0-9a-fA-F]+)>)/g,
    )) {
      const low = parseInt(range[1]!, 16);
      const high = parseInt(range[2]!, 16);

      if (range[3] !== undefined) {
        const items = [...range[3].matchAll(/<([0-9a-fA-F\s]*?)>/g)].map((item) => item[1]!);
        for (let i = 0; i <= high - low; i++) map.set(low + i, decode(items[i] ?? ''));
      } else {
        const base = parseInt(range[4]!, 16);
        for (let i = 0; i <= high - low; i++) map.set(low + i, String.fromCharCode(base + i));
      }
    }
  }

  return map;
}

/** Texte tel qu'un lecteur PDF l'affichera. */
function extractPdfText(bytes: Uint8Array): string {
  const objects = readPdfObjects(bytes);

  const fonts = new Map<string, Map<number, string>>();
  for (const body of objects.values()) {
    const dict = body.match(/\/Font\s*<<([\s\S]*?)>>/);
    if (!dict) continue;
    for (const ref of dict[1]!.matchAll(/\/(\w+)\s+(\d+)\s+0\s+R/g)) {
      const toUnicode = objects.get(Number(ref[2]))?.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
      if (!toUnicode) continue;
      fonts.set(ref[1]!, parseToUnicode(objects.get(Number(toUnicode[1]!)) ?? ''));
    }
  }

  let text = '';
  for (const body of objects.values()) {
    if (!/\bTf\b/.test(body) || !/\bTJ\b|\bTj\b/.test(body)) continue;

    let current: Map<number, string> | undefined;
    for (const token of body.matchAll(/\/(\w+)\s+[\d.]+\s+Tf|<([0-9a-fA-F]+)>|\bET\b/g)) {
      if (token[1]) current = fonts.get(token[1]);
      else if (token[2] && current) {
        for (const glyph of token[2].match(/.{4}/g) ?? []) {
          text += current.get(parseInt(glyph, 16)) ?? NOTDEF;
        }
      } else if (token[0] === 'ET') text += '\n';
    }
  }

  return text;
}

/** Un DOCX est un ZIP : le texte vit dans `word/document.xml`. */
async function extractDocxText(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(Buffer.from(bytes));
  const xml = await zip.file('word/document.xml')!.async('string');
  return xml.replace(/<[^>]*>/g, ' ');
}

/**
 * Les motifs interdits sont coupés en plusieurs « runs » par le rendu : on
 * compare donc sur une forme SANS AUCUNE espace, qui recolle les fragments.
 */
function dense(text: string): string {
  return text.replace(/\s+/g, '');
}

/**
 * Les cinq motifs de l'incident, réunis dans un seul document.
 *
 * Titre ET corps : le titre n'était pas moins exposé que le corps, et il traverse
 * un autre chemin (`titleOf`, plus le nom de fichier).
 */
const HOSTILE = {
  title: 'Guide 🚀 **Onboarding** [SECURITY_BLOCK]',
  content: [
    'Bienvenue 👋 chez Kisso, **bon courage** !',
    '',
    '# Ton parcours',
    '',
    '- Configurer ton poste',
    '- Rejoindre les canaux',
    '',
    '---',
    '',
    '| Département | Engineering |',
    '| Poste | Backend |',
    '',
    'Le délimiteur kisso_0123456789abcdef0123456789abcdef et la DIRECTIVE 3.1 ne doivent pas sortir.',
    'Télécharge-le sur https://kisso.internal/docs/abc/download',
  ].join('\n'),
};

/** Les cinq motifs, sous la forme qu'ils prendraient dans les octets rendus. */
const FORBIDDEN: ReadonlyArray<readonly [string, string]> = [
  ['emoji (glyphe .notdef)', NOTDEF],
  ['gras markdown', '**'],
  ['marqueur de sécurité', '[SECURITY_BLOCK]'],
  ['délimiteur de session', 'kisso_0123456789abcdef0123456789abcdef'],
  ['lien fabriqué', 'kisso.internal'],
];

describe('Sécurité du rendu — le document est un canal de sortie FILTRÉ', () => {
  it('n’imprime aucun des cinq motifs dans les octets PDF réellement produits', async () => {
    const rendered = await new PdfmakeService().render({
      type: DocumentType.Guide,
      ...HOSTILE,
      employee,
    });

    const text = extractPdfText(rendered.bytes);

    // Garde-fou anti faux-négatif : sans lui, un extracteur cassé rendrait ''
    // et TOUTES les assertions ci-dessous passeraient à vide.
    expect(dense(text)).toContain('BienvenuechezKisso');

    for (const [label, motif] of FORBIDDEN) {
      expect(dense(text), `${label} présent dans le PDF`).not.toContain(dense(motif));
    }
    expect(dense(text)).not.toContain('DIRECTIVE3.1');
    // Le balisage résiduel non plus : ni titre markdown, ni barre de tableau,
    // ni séparateur horizontal — tous imprimés littéralement auparavant.
    expect(text).not.toContain('#');
    expect(text).not.toContain('|');
    expect(text).not.toContain('---');
  });

  it('n’imprime aucun des cinq motifs dans les octets DOCX réellement produits', async () => {
    const rendered = await new DocxService().render({
      type: DocumentType.Guide,
      ...HOSTILE,
      employee,
    });

    const text = await extractDocxText(rendered.bytes);

    expect(dense(text)).toContain('BienvenuechezKisso');

    for (const [label, motif] of FORBIDDEN) {
      expect(dense(text), `${label} présent dans le DOCX`).not.toContain(dense(motif));
    }
    expect(dense(text)).not.toContain('DIRECTIVE3.1');
  });

  it('TRADUIT le markdown en structure au lieu de l’imprimer', async () => {
    // Le corps garde son sens : le titre reste un titre, les puces restent des
    // puces, le tableau à deux colonnes devient un bloc de champs.
    const rendered = await new PdfmakeService().render({
      type: DocumentType.Other,
      ...HOSTILE,
      employee,
    });

    const text = dense(extractPdfText(rendered.bytes));

    expect(text).toContain('Tonparcours');
    expect(text).toContain('Configurertonposte');
    expect(text).toContain('Rejoindrelescanaux');
    expect(text).toContain('Département');
    expect(text).toContain('Engineering');
  });

  it('le nom de fichier ne porte plus rien du contenu assaini', async () => {
    const rendered = await new PdfmakeService().render({
      type: DocumentType.Guide,
      ...HOSTILE,
      employee,
    });

    expect(rendered.filename).not.toContain('security');
    expect(rendered.filename).toMatch(/^[a-z0-9-]+\.pdf$/);
  });
});

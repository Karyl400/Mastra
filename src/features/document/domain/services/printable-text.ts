export interface GlyphSource {
  hasGlyph(codePoint: number): boolean;
}

const FALLBACKS: Readonly<Record<number, string>> = {
  0x2192: '->',
  0x21d2: '=>',
  0x21a6: '->',
  0x2190: '<-',
  0x2194: '<->',
  0x202f: ' ',
  0x2007: ' ',
  0x2009: ' ',
  0x200a: ' ',
  0x2060: '',
  0xfeff: '',
};

export interface PrintableText {
  readonly text: string;
  readonly replaced: readonly string[];
}

export function toPrintableText(raw: string, glyphs: GlyphSource): PrintableText {
  const seen = new Set<string>();
  let out = '';

  for (const char of raw) {
    const cp = char.codePointAt(0)!;

    if (cp < 0x20 || cp === 0x7f) {
      out += char;
      continue;
    }

    if (glyphs.hasGlyph(cp)) {
      out += char;
      continue;
    }

    seen.add(`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
    out += FALLBACKS[cp] ?? '';
  }

  return { text: out, replaced: [...seen].sort() };
}

/* eslint-disable security/detect-non-literal-regexp */

const HOMOGLYPH_FOLDING: ReadonlyMap<string, string> = new Map([
  ['а', 'a'],
  ['е', 'e'],
  ['ѕ', 's'],
  ['і', 'i'],
  ['ј', 'j'],
  ['о', 'o'],
  ['р', 'p'],
  ['с', 'c'],
  ['у', 'y'],
  ['х', 'x'],
  ['ԁ', 'd'],
  ['һ', 'h'],
  ['ӏ', 'l'],
  ['ԛ', 'q'],
  ['ԝ', 'w'],
  ['ѵ', 'v'],
  ['А', 'A'],
  ['В', 'B'],
  ['Е', 'E'],
  ['І', 'I'],
  ['Ј', 'J'],
  ['К', 'K'],
  ['М', 'M'],
  ['Н', 'H'],
  ['О', 'O'],
  ['Р', 'P'],
  ['С', 'C'],
  ['Т', 'T'],
  ['У', 'Y'],
  ['Х', 'X'],
  ['Ѕ', 'S'],
  ['Ԛ', 'Q'],
  ['Ԝ', 'W'],
  ['Ѵ', 'V'],
  ['α', 'a'],
  ['β', 'b'],
  ['ε', 'e'],
  ['η', 'n'],
  ['ι', 'i'],
  ['κ', 'k'],
  ['ν', 'v'],
  ['ο', 'o'],
  ['ρ', 'p'],
  ['τ', 't'],
  ['υ', 'u'],
  ['χ', 'x'],
  ['ϲ', 'c'],
  ['Α', 'A'],
  ['Β', 'B'],
  ['Ε', 'E'],
  ['Ζ', 'Z'],
  ['Η', 'H'],
  ['Ι', 'I'],
  ['Κ', 'K'],
  ['Μ', 'M'],
  ['Ν', 'N'],
  ['Ο', 'O'],
  ['Ρ', 'P'],
  ['Τ', 'T'],
  ['Υ', 'Y'],
  ['Χ', 'X'],
]);

const HOMOGLYPH_PATTERN = new RegExp(`[${[...HOMOGLYPH_FOLDING.keys()].join('')}]`, 'gu');

function foldHomoglyphs(text: string): string {
  return text.replace(HOMOGLYPH_PATTERN, (char) => HOMOGLYPH_FOLDING.get(char) ?? char);
}

export function normalizeForDetection(text: string): string {
  return foldHomoglyphs(
    text
      .normalize('NFKC')
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replace(/[\u200B-\u200F\u2060\uFEFF]/gu, ''),
  ).replace(/['’‘`´]/g, "'");
}

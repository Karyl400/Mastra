import type { DocumentBlock } from './document-blocks';

const HEADING_LINE = /^[ \t]{0,8}(#{1,6})[ \t]+(.*)/;
const BULLET_LINE = /^[ \t]{0,8}(?:[-*+]|\d{1,3}[.)])[ \t]+(.*)/;
const HORIZONTAL_RULE = /^[ \t]{0,8}([-*_])\1{2,}[ \t]{0,8}$/;
const TABLE_LINE = /^[ \t]{0,8}\|/;
const CODE_FENCE = /^[ \t]{0,8}```/;

function isTableDivider(row: string): boolean {
  const trimmed = row.trim();
  return trimmed.length > 0 && [...trimmed].every((char) => '|:- \t'.includes(char));
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function tableBlocks(rows: string[]): DocumentBlock[] {
  const cells = rows
    .filter((row) => !isTableDivider(row))
    .map(tableCells)
    .filter((row) => row.some((cell) => cell.length > 0));

  if (cells.length === 0) return [];

  if (cells.every((row) => row.length === 2)) {
    return [{ kind: 'fields', rows: cells.map((row) => [row[0] ?? '', row[1] ?? ''] as const) }];
  }

  return [{ kind: 'bullets', items: cells.map((row) => row.join(' — ')) }];
}

export function splitParagraphs(content: string): string[] {
  const normalized = (content ?? '').replace(/\r\n?/g, '\n').trim();
  if (normalized.length === 0) return [];

  const separator = normalized.includes('\n\n') ? /\n{2,}/ : /\n/;

  return normalized
    .split(separator)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

export function parseContentBlocks(content: string): DocumentBlock[] {
  const lines = (content ?? '').replace(/\r\n?/g, '\n').split('\n');

  const blocks: DocumentBlock[] = [];
  let paragraph: string[] = [];
  let bullets: string[] = [];
  let table: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    for (const text of splitParagraphs(paragraph.join('\n')))
      blocks.push({ kind: 'paragraph', text });
    paragraph = [];
  };
  const flushBullets = () => {
    if (bullets.length === 0) return;
    blocks.push({ kind: 'bullets', items: bullets });
    bullets = [];
  };
  const flushTable = () => {
    if (table.length === 0) return;
    blocks.push(...tableBlocks(table));
    table = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushBullets();
    flushTable();
  };

  for (const line of lines) {
    if (CODE_FENCE.test(line) || HORIZONTAL_RULE.test(line)) {
      flushAll();
      continue;
    }

    if (line.trim().length === 0) {
      flushAll();
      continue;
    }

    if (TABLE_LINE.test(line)) {
      flushParagraph();
      flushBullets();
      table.push(line);
      continue;
    }
    flushTable();

    const heading = HEADING_LINE.exec(line);
    if (heading) {
      flushAll();
      blocks.push({ kind: 'heading', text: heading[2] ?? '', level: 2 });
      continue;
    }

    const bullet = BULLET_LINE.exec(line);
    if (bullet) {
      flushParagraph();
      bullets.push(bullet[1] ?? '');
      continue;
    }
    flushBullets();

    paragraph.push(line);
  }

  flushAll();
  return blocks;
}

import { DocumentType } from '../../../../shared/types';
import { sanitizeDocumentText } from '../../../../shared/security/agent-output';
import { formatFrenchDay } from '../../../../shared/french-date';
import { fullName } from '../../../../shared/name-matching';
import type { DocumentRenderInput } from '../ports/document-renderer';

export type DocumentBlock =
  | { kind: 'heading'; text: string; level: 1 | 2 }
  | { kind: 'paragraph'; text: string; italic?: boolean }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'fields'; rows: ReadonlyArray<readonly [string, string]> };

export interface DocumentOutline {
  title: string;
  blocks: DocumentBlock[];
}

const COMPANY = 'KISSO INDUSTRIES';

export const DEFAULT_TITLES: Record<DocumentType, string> = {
  [DocumentType.Contract]: 'Contrat de travail',
  [DocumentType.Amendment]: 'Avenant au contrat',
  [DocumentType.WelcomeLetter]: 'Lettre de bienvenue',
  [DocumentType.Guide]: 'Guide d’onboarding',
  [DocumentType.Certificate]: 'Certificat d’onboarding',
  [DocumentType.Policy]: 'Politique interne',
  [DocumentType.TaxForm]: 'Document fiscal',
  [DocumentType.IDDocument]: 'Pièce d’identité',
  [DocumentType.Other]: 'Document',
};

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

function recipientName(input: DocumentRenderInput): string {
  const { firstName, lastName } = input.employee ?? {};
  return fullName(firstName, lastName);
}

function recipientBlocks(input: DocumentRenderInput): DocumentBlock[] {
  const name = recipientName(input);
  if (name.length === 0) return [];
  return [{ kind: 'paragraph', text: `Document destiné à ${name}.`, italic: true }];
}

function titleOf(input: DocumentRenderInput): string {
  const provided = (input.title ?? '').trim();
  return provided.length > 0 ? provided : DEFAULT_TITLES[input.type];
}

function bodyBlocks(input: DocumentRenderInput): DocumentBlock[] {
  return parseContentBlocks(input.content);
}

function buildContract(input: DocumentRenderInput): DocumentBlock[] {
  const employee = input.employee ?? {};
  return [
    { kind: 'heading', text: COMPANY, level: 1 },
    { kind: 'heading', text: titleOf(input), level: 2 },
    {
      kind: 'fields',
      rows: [
        ['Employé', recipientName(input)],
        ['Email', employee.email ?? ''],
        ['Poste', employee.position ?? ''],
      ].map((row) => [row[0], row[1]] as [string, string]),
    },
    ...bodyBlocks(input),
  ];
}

function buildWelcomeLetter(input: DocumentRenderInput): DocumentBlock[] {
  const employee = input.employee ?? {};

  const positionClause = employee.position ? ` en tant que ${employee.position}` : '';

  const startDay = formatFrenchDay(employee.startDate);

  return [
    { kind: 'heading', text: COMPANY, level: 1 },
    { kind: 'heading', text: titleOf(input), level: 2 },
    { kind: 'paragraph', text: `Bonjour ${recipientName(input)},` },
    {
      kind: 'paragraph',
      text: `Ravis de t'accueillir chez Kisso Industries${positionClause}.`,
    },
    ...(startDay
      ? [{ kind: 'paragraph' as const, text: `Ton premier jour est le ${startDay}.` }]
      : []),
    ...interviewBlocks(input),
    ...bodyBlocks(input),
    { kind: 'paragraph', text: 'Bienvenue dans l’équipe !', italic: true },
  ];
}

function buildCertificate(input: DocumentRenderInput): DocumentBlock[] {
  return [
    { kind: 'heading', text: titleOf(input), level: 1 },
    {
      kind: 'paragraph',
      text: `${recipientName(input)} a complété son onboarding chez Kisso Industries.`,
    },
    ...bodyBlocks(input),
  ];
}

function interviewBlocks(input: DocumentRenderInput): DocumentBlock[] {
  const interview = input.interview;
  if (!interview) return [];

  const blocks: DocumentBlock[] = [];

  const dailyWork = (interview.dailyWork ?? '').trim();
  if (dailyWork.length > 0) {
    blocks.push(
      { kind: 'heading', text: 'Ton quotidien', level: 2 },
      { kind: 'paragraph', text: dailyWork },
    );
  }

  const workStyle = (interview.workStyle ?? '').trim();
  if (workStyle.length > 0) {
    blocks.push(
      { kind: 'heading', text: 'Ta façon de travailler', level: 2 },
      { kind: 'paragraph', text: workStyle },
    );
  }

  const channels = (interview.channels ?? []).filter((name) => name.trim().length > 0);
  if (channels.length > 0) {
    blocks.push(
      { kind: 'heading', text: 'Tes canaux', level: 2 },
      { kind: 'bullets', items: channels.map((name) => `#${name}`) },
    );
  }

  return blocks;
}

function buildGuide(input: DocumentRenderInput): DocumentBlock[] {
  const employee = input.employee ?? {};
  return [
    { kind: 'heading', text: titleOf(input), level: 1 },
    ...recipientBlocks(input),
    ...(employee.position
      ? [{ kind: 'paragraph' as const, text: `Poste : ${employee.position}` }]
      : []),
    ...interviewBlocks(input),
    ...bodyBlocks(input),
  ];
}

function buildGeneric(input: DocumentRenderInput): DocumentBlock[] {
  const body = bodyBlocks(input);
  return [
    { kind: 'heading', text: titleOf(input), level: 1 },
    ...recipientBlocks(input),
    ...(body.length > 0 ? body : [{ kind: 'paragraph' as const, text: '' }]),
  ];
}

const TEMPLATES: Partial<Record<DocumentType, (input: DocumentRenderInput) => DocumentBlock[]>> = {
  [DocumentType.Contract]: buildContract,
  [DocumentType.WelcomeLetter]: buildWelcomeLetter,
  [DocumentType.Certificate]: buildCertificate,
  [DocumentType.Guide]: buildGuide,
};

function clean(text: string): string {
  return sanitizeDocumentText(text).text;
}

function sanitizeBlock(block: DocumentBlock): DocumentBlock | undefined {
  switch (block.kind) {
    case 'heading':
    case 'paragraph': {
      const text = clean(block.text);
      return text.length > 0 ? { ...block, text } : undefined;
    }
    case 'bullets': {
      const items = block.items.map(clean).filter((item) => item.length > 0);
      return items.length > 0 ? { kind: 'bullets', items } : undefined;
    }
    case 'fields': {
      const rows = block.rows.map((row) => [clean(row[0]), clean(row[1])] as const);
      return rows.length > 0 ? { kind: 'fields', rows } : undefined;
    }
  }
}

export function buildDocumentOutline(input: DocumentRenderInput): DocumentOutline {
  const template = TEMPLATES[input.type] ?? buildGeneric;

  const blocks = template(input)
    .map(sanitizeBlock)
    .filter((block): block is DocumentBlock => block !== undefined);

  const title = clean(titleOf(input));

  return {
    title: title.length > 0 ? title : DEFAULT_TITLES[input.type],
    blocks: blocks.length > 0 ? blocks : [{ kind: 'paragraph', text: '' }],
  };
}

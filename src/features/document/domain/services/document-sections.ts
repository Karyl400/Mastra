import { DocumentType } from '../../../../shared/types';
import { formatFrenchDay } from '../../../../shared/french-date';
import { fullName } from '../../../../shared/name-matching';
import type { DocumentRenderInput } from '../ports/document-renderer';
import type { DocumentBlock } from './document-blocks';
import { parseContentBlocks } from './document-markdown';
import { titleOf } from './document-titles';

const COMPANY = 'KISSO INDUSTRIES';

function recipientName(input: DocumentRenderInput): string {
  const { firstName, lastName } = input.employee ?? {};
  return fullName(firstName, lastName);
}

function recipientBlocks(input: DocumentRenderInput): DocumentBlock[] {
  const name = recipientName(input);
  if (name.length === 0) {
    return [];
  }
  return [{ kind: 'paragraph', text: `Document destiné à ${name}.`, italic: true }];
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
  if (!interview) {
    return [];
  }

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

export function buildGeneric(input: DocumentRenderInput): DocumentBlock[] {
  const body = bodyBlocks(input);
  return [
    { kind: 'heading', text: titleOf(input), level: 1 },
    ...recipientBlocks(input),
    ...(body.length > 0 ? body : [{ kind: 'paragraph' as const, text: '' }]),
  ];
}

export const TEMPLATES: Partial<
  Record<DocumentType, (input: DocumentRenderInput) => DocumentBlock[]>
> = {
  [DocumentType.Contract]: buildContract,
  [DocumentType.WelcomeLetter]: buildWelcomeLetter,
  [DocumentType.Certificate]: buildCertificate,
  [DocumentType.Guide]: buildGuide,
};

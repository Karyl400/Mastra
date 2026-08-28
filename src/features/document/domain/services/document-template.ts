import { sanitizeDocumentText } from '../../../../shared/security/agent-output';
import type { DocumentRenderInput } from '../ports/document-renderer';
import type { DocumentBlock, DocumentOutline } from './document-blocks';
import { DEFAULT_TITLES, titleOf } from './document-titles';
import { TEMPLATES, buildGeneric } from './document-sections';

export type { DocumentBlock, DocumentOutline } from './document-blocks';
export { DEFAULT_TITLES } from './document-titles';
export { splitParagraphs, parseContentBlocks } from './document-markdown';

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

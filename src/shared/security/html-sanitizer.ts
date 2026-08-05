import sanitizeHtmlLib from 'sanitize-html';

export function sanitizeHtml(value: string): string {
  return sanitizeHtmlLib(value, {
    allowedTags: [],
    allowedAttributes: {},
    disallowedTagsMode: 'discard',
  });
}

export function sanitizeRichHtml(value: string): string {
  return sanitizeHtmlLib(value, {
    allowedTags: ['b', 'i', 'strong', 'em', 'p', 'ul', 'ol', 'li', 'br'],
    allowedAttributes: {},
  });
}

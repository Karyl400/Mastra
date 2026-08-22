import sanitizeHtmlLib from 'sanitize-html';

export function sanitizeHtml(value: string): string {
  return sanitizeHtmlLib(value, {
    allowedTags: [],
    allowedAttributes: {},
    disallowedTagsMode: 'discard',
  });
}

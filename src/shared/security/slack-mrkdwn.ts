import { CODE_BLOCK_SPLIT } from './outbound-links';

function convertBold(segment: string): string {
  const parts = segment.split('**');
  if (parts.length < 3) return segment;

  const balanced = parts.length % 2 === 1;
  const paired = balanced ? parts : parts.slice(0, -1);
  const tail = balanced ? '' : `**${parts[parts.length - 1]}`;

  return paired.map((part, index) => (index % 2 === 1 ? `*${part}*` : part)).join('') + tail;
}

// eslint-disable-next-line security/detect-unsafe-regex
const UNICODE_EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]|\u{FE0F}|\u{200D}/gu;

const SLACK_SHORTCODE = /:[a-z][a-z0-9_+-]{1,30}:/g;

export function stripEmojis(segment: string): string {
  const withoutEmojis = segment.replace(SLACK_SHORTCODE, '').replace(UNICODE_EMOJI, '');
  if (withoutEmojis === segment) return segment;

  return withoutEmojis
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]([,.])/g, '$1')
    .replace(/[ \t]$/gm, '');
}

function convertOutsideCode(segment: string): string {
  return stripEmojis(convertBold(segment))
    .replace(/^#{1,6}[ \t]([^\n]*)$/gm, (_match, title: string) => `*${title.trim()}*`)
    .replace(/^[ \t]*-{3,}[ \t]*$\n?/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}

export function toSlackMrkdwn(text: string): string {
  return text
    .split(CODE_BLOCK_SPLIT)
    .map((segment, index) => (index % 2 === 1 ? segment : convertOutsideCode(segment)))
    .join('');
}

const UNKNOWN_QUALIFIER = /(?<=mails?|adresses?)[ \t]+(?:professionnel(?:le)?s?|pro)(?!\p{L})/giu;

export function dropUnknownQualifiers(text: string): string {
  return text.replace(UNKNOWN_QUALIFIER, '');
}

export function stripMarkdownMarkup(text: string): string {
  return text
    .split('```')
    .join('')
    .split('**')
    .join('')
    .split('__')
    .join('')
    .split('~~')
    .join('')
    .replace(/`/g, '')
    .replace(/^[ \t]{0,8}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]{0,8}>[ \t]?/gm, '')
    .replace(/^[ \t]{0,8}[-*+][ \t]+/gm, '')
    .replace(/^[ \t]{0,8}\d{1,3}[.)][ \t]+/gm, '')
    .replace(/^[ \t]{0,8}([-*_])\1{2,}[ \t]{0,8}$/gm, '')
    .replace(/\|/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const NEUTRAL_REFUSAL =
  'Je ne peux pas traiter ce message tel quel. Reformule-le en une ou deux phrases, ' +
  'en disant ce que tu veux obtenir — je réessaie tout de suite.';

export const ALLOWED_LINK_DOMAINS: readonly string[] = ['kissohq.slack.com', 'slack.com'];

export const STRIPPED_LINK_PLACEHOLDER = '[lien retiré]';

export const REDACTED_MARKER_PLACEHOLDER = '[retiré]';

export interface SanitizedAgentOutput {
  text: string;
  redacted: string[];
  strippedUrls: string[];
}

const INTERNAL_MARKERS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'delimiter', pattern: /kisso_[0-9a-f]{16,}/i },
  { label: 'security_marker', pattern: /\[SECURITY_BLOCK\]/i },
  { label: 'agent_identity', pattern: /KISSO-AGENT-v\d+/i },
  { label: 'directive', pattern: /\bDIRECTIVE\s+\d+\.\d+/i },

  { label: 'directives_block', pattern: /IMMUTABLE DIRECTIVES/i },
  { label: 'session_id', pattern: /\[SECURITY_ID:/i },
  { label: 'enterprise_mode', pattern: /STRICT-ENTERPRISE-MODE/i },
  { label: 'tool_firewall', pattern: /TOOL EXECUTION FIREWALL/i },
];

export function containsInternalMarkers(text: string): string[] {
  return INTERNAL_MARKERS.filter((marker) => marker.pattern.test(text)).map(
    (marker) => marker.label,
  );
}

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

function stripEmojis(segment: string): string {
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

const CODE_BLOCK_SPLIT = /(```[\s\S]*?```)/g;

const MRKDWN_TOKEN = /<[^<>]*>/g;

const HTTP_PREFIX = /^https?:\/\//i;

const BARE_URL = /https?:\/\/[^\s<>|"'`]+/g;

const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}']);

function trimTrailingPunctuation(url: string): string {
  let end = url.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(url[end - 1] as string)) end -= 1;
  return url.slice(0, end);
}

function hostnameOf(url: string): string {
  const schemeEnd = url.indexOf('://');
  if (schemeEnd === -1) return '';

  const afterScheme = url.slice(schemeEnd + 3);
  const pathStart = afterScheme.search(/[/?#]/);
  let authority = pathStart === -1 ? afterScheme : afterScheme.slice(0, pathStart);

  const userInfoEnd = authority.lastIndexOf('@');
  if (userInfoEnd !== -1) authority = authority.slice(userInfoEnd + 1);

  const portStart = authority.lastIndexOf(':');
  if (portStart !== -1 && /^\d*$/.test(authority.slice(portStart + 1))) {
    authority = authority.slice(0, portStart);
  }

  return authority.toLowerCase();
}

function isAllowedHost(host: string): boolean {
  return ALLOWED_LINK_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function filterLinks(segment: string, seen: Set<string>): string {
  return segment
    .replace(MRKDWN_TOKEN, (token) => {
      const inner = token.slice(1, -1);
      const pipe = inner.indexOf('|');
      const target = pipe === -1 ? inner : inner.slice(0, pipe);

      if (!HTTP_PREFIX.test(target)) return token;

      const host = hostnameOf(target);
      if (isAllowedHost(host)) return token;
      if (host) seen.add(host);
      return STRIPPED_LINK_PLACEHOLDER;
    })
    .replace(BARE_URL, (match) => {
      const trimmed = trimTrailingPunctuation(match);
      const host = hostnameOf(trimmed);
      if (isAllowedHost(host)) return match;
      if (host) seen.add(host);
      return STRIPPED_LINK_PLACEHOLDER + match.slice(trimmed.length);
    });
}

function stripDisallowedLinks(text: string): { text: string; hostnames: string[] } {
  const seen = new Set<string>();

  const filtered = text
    .split(CODE_BLOCK_SPLIT)
    .map((segment, index) => (index % 2 === 1 ? segment : filterLinks(segment, seen)))
    .join('');

  return { text: filtered, hostnames: [...seen] };
}

function toSlackMrkdwn(text: string): string {
  return text
    .split(CODE_BLOCK_SPLIT)
    .map((segment, index) => (index % 2 === 1 ? segment : convertOutsideCode(segment)))
    .join('');
}

const UNKNOWN_QUALIFIER = /(?<=mails?|adresses?)[ \t]+(?:professionnel(?:le)?s?|pro)(?!\p{L})/giu;

function dropUnknownQualifiers(text: string): string {
  return text.replace(UNKNOWN_QUALIFIER, '');
}

export function sanitizeAgentOutput(raw: string | undefined | null): SanitizedAgentOutput {
  const text = (raw ?? '').trim();

  if (!text) return { text: NEUTRAL_REFUSAL, redacted: [], strippedUrls: [] };

  const redacted = containsInternalMarkers(text);

  if (redacted.length > 0) return { text: NEUTRAL_REFUSAL, redacted, strippedUrls: [] };

  const { text: withoutLinks, hostnames } = stripDisallowedLinks(text);

  return {
    text: dropUnknownQualifiers(toSlackMrkdwn(withoutLinks)),
    redacted: [],
    strippedUrls: hostnames,
  };
}

const INTERNAL_MARKERS_GLOBAL = INTERNAL_MARKERS.map(({ label, pattern }) => ({
  label,
  // eslint-disable-next-line security/detect-non-literal-regexp
  pattern: new RegExp(pattern.source, `${pattern.flags}g`),
}));

const MARKDOWN_LINK = /\[([^\]\n]{0,200})\]\(([^)\s]{0,2000})\)/g;

export interface SanitizedDocumentText {
  text: string;
  redacted: string[];
  strippedUrls: string[];
}

function redactAndFilter(raw: string | undefined | null): SanitizedDocumentText {
  const redacted: string[] = [];
  let text = (raw ?? '').replace(/\r\n?/g, '\n');

  for (const { label, pattern } of INTERNAL_MARKERS_GLOBAL) {
    const next = text.replace(pattern, REDACTED_MARKER_PLACEHOLDER);
    if (next === text) continue;
    redacted.push(label);
    text = next;
  }

  const seen = new Set<string>();
  text = filterLinks(text.replace(MARKDOWN_LINK, '$1 $2'), seen);

  return { text, redacted, strippedUrls: [...seen] };
}

export const NOTIFICATION_BODY_PLACEHOLDER =
  "(Le contenu de cette notification a été retiré : il n'a pas passé le contrôle de sortie.)";

export function sanitizeNotificationBody(raw: string | undefined | null): SanitizedDocumentText {
  const { text, redacted, strippedUrls } = redactAndFilter(raw);
  const clean = dropUnknownQualifiers(text).trim();

  return {
    text: clean.length > 0 ? clean : NOTIFICATION_BODY_PLACEHOLDER,
    redacted,
    strippedUrls,
  };
}

export function sanitizeDocumentSource(raw: string | undefined | null): SanitizedDocumentText {
  const { text, redacted, strippedUrls } = redactAndFilter(raw);

  return {
    text: dropUnknownQualifiers(stripEmojis(text).trim()),
    redacted,
    strippedUrls,
  };
}

function stripMarkdownMarkup(text: string): string {
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

export function sanitizeDocumentText(raw: string | undefined | null): SanitizedDocumentText {
  const source = sanitizeDocumentSource(raw);
  return { ...source, text: stripMarkdownMarkup(source.text) };
}

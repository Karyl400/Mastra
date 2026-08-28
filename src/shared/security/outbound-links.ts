export const ALLOWED_LINK_DOMAINS: readonly string[] = ['kissohq.slack.com', 'slack.com'];

export const STRIPPED_LINK_PLACEHOLDER = '[lien retiré]';

export const CODE_BLOCK_SPLIT = /(```[\s\S]*?```)/g;

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
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isAllowedHost(host: string): boolean {
  return ALLOWED_LINK_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function filterLinks(segment: string, seen: Set<string>): string {
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

export function stripDisallowedLinks(text: string): { text: string; hostnames: string[] } {
  const seen = new Set<string>();

  const filtered = text
    .split(CODE_BLOCK_SPLIT)
    .map((segment, index) => (index % 2 === 1 ? segment : filterLinks(segment, seen)))
    .join('');

  return { text: filtered, hostnames: [...seen] };
}

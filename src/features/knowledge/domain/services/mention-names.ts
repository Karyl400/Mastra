const SLACK_TOKEN = /<([@#])([^>]{1,140})>/g;

function splitToken(inner: string): { id: string; label?: string } {
  const bar = inner.indexOf('|');
  return bar === -1 ? { id: inner } : { id: inner.slice(0, bar), label: inner.slice(bar + 1) };
}

const USER_ID = /^[UW][A-Z0-9]{2,24}$/i;
const CHANNEL_ID = /^C[A-Z0-9]{2,24}$/i;

export type NameLookup = (slackUserId: string) => string | undefined;

export function resolveMentions(text: string, lookup: NameLookup): string {
  return text.replace(SLACK_TOKEN, (whole, sigil: string, inner: string) => {
    const { id, label } = splitToken(inner);

    if (sigil === '@' && USER_ID.test(id)) {
      const name = lookup(id)?.trim();
      return name ? `@${name}` : whole;
    }

    if (sigil === '#' && CHANNEL_ID.test(id) && label) return `#${label}`;

    return whole;
  });
}

export function mentionedUserIds(texts: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(SLACK_TOKEN)) {
      if (match[1] !== '@') continue;
      const { id } = splitToken(match[2]!);
      if (USER_ID.test(id)) ids.add(id.toUpperCase());
    }
  }
  return [...ids];
}

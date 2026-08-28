export function unwrapSanitizedInput(wrapped: string, fallback: string): string {
  const firstNewline = wrapped.indexOf('\n');
  const lastNewline = wrapped.lastIndexOf('\n');
  if (firstNewline < 0 || lastNewline <= firstNewline) return fallback;
  return wrapped.slice(firstNewline + 1, lastNewline);
}

export function cleanText(text: string | undefined, botUserId?: string): string {
  // eslint-disable-next-line security/detect-non-literal-regexp
  const botMention = new RegExp(`<@${(botUserId ?? '').replace(/[^A-Z0-9]/gi, '')}>`, 'g');
  const mentions = botUserId ? botMention : /<@[A-Z0-9]+>/g;

  return (text ?? '').replace(mentions, ' ').replace(/\s+/g, ' ').trim();
}

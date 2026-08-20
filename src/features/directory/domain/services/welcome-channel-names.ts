export function parseWelcomeChannelNames(raw: string | undefined | null): readonly string[] {
  const seen = new Set<string>();

  for (const part of (raw ?? '').split(',')) {
    const name = part.trim().replace(/^#+/, '').trim().toLowerCase();
    if (name) seen.add(name);
  }

  return Array.from(seen);
}

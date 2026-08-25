import type { ChannelRef } from '../ports/channel-history.port';

export type ChannelNameMatch = { readonly id: string } | { readonly ambiguous: readonly string[] };

export function normalizeChannelName(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/^[#@]+/, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-|-$/g, '')
    .trim();
}

export function resolveChannelName(
  channels: readonly ChannelRef[],
  wanted: string | null | undefined,
): ChannelNameMatch | null {
  const needle = normalizeChannelName(wanted);
  if (!needle) return null;

  const exact = channels.filter((channel) => normalizeChannelName(channel.name) === needle);
  if (exact.length === 1) return { id: exact[0].id };
  if (exact.length > 1) return { ambiguous: exact.map((channel) => channel.name).sort() };

  const prefixed = channels.filter((channel) =>
    normalizeChannelName(channel.name).startsWith(needle),
  );
  if (prefixed.length === 1) return { id: prefixed[0].id };
  if (prefixed.length > 1) return { ambiguous: prefixed.map((channel) => channel.name).sort() };

  return null;
}

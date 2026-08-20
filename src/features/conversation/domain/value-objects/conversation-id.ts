export interface SlackConversationRef {
  readonly channel: string;
  readonly threadTs?: string | null;
}

export function deriveConversationId({ channel, threadTs }: SlackConversationRef): string {
  const normalizedChannel = channel.trim();
  if (!normalizedChannel) {
    throw new Error('deriveConversationId: channel is required');
  }

  const normalizedThreadTs = threadTs?.trim();
  return normalizedThreadTs ? `${normalizedChannel}:${normalizedThreadTs}` : normalizedChannel;
}

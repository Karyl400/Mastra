export type ExcerptSource = 'bot_memory' | 'channel';

export interface ConversationExcerpt {
  readonly source: ExcerptSource;

  readonly speaker: string;

  readonly text: string;

  readonly at: Date;
}

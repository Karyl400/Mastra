import type { FactKind } from '../services/fact-distillation';

export interface KnowledgeFact {
  readonly id: string;
  readonly channelId: string;
  readonly slackUserId: string | null;
  readonly kind: FactKind;
  readonly summary: string;
  readonly score: number;
  readonly postedAt: number;
}

export interface KnowledgeFactSearchOptions {
  readonly channelId?: string;
  readonly slackUserId?: string;
  readonly limit?: number;
}

export interface KnowledgeFactRepository {
  record(fact: KnowledgeFact): Promise<boolean>;
  search(query: string, options?: KnowledgeFactSearchOptions): Promise<readonly KnowledgeFact[]>;
  recent(options?: KnowledgeFactSearchOptions): Promise<readonly KnowledgeFact[]>;
  forgetUser(slackUserId: string): Promise<number>;
  prune(before: number): Promise<number>;
}

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

import type { ForgetScope } from './message-archive.repository';

/**
 * ⚠️ **La portée des faits doit suivre celle de l'archive dont ils sont DÉRIVÉS.** Si les
 * deux divergeaient, un fait distillé d'un DM effacé survivrait à son message source, et
 * `searchKnowledge` le rendrait encore : le pire des deux moitiés — la trace disparaît, le
 * résumé reste. `ForgetScope` est donc importé, jamais redéclaré.
 */
export interface KnowledgeFactRepository {
  record(fact: KnowledgeFact): Promise<boolean>;
  search(query: string, options?: KnowledgeFactSearchOptions): Promise<readonly KnowledgeFact[]>;
  recent(options?: KnowledgeFactSearchOptions): Promise<readonly KnowledgeFact[]>;
  forgetUser(scope: ForgetScope): Promise<number>;
  prune(before: number): Promise<number>;
}

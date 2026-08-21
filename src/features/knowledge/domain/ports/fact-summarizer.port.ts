import type { FactKind } from '../services/fact-distillation';

export interface SummarizableMessage {
  readonly id: string;
  readonly text: string;
}

export interface SummarizedFact {
  readonly index: number;
  readonly kind: FactKind;
  readonly summary: string;
}

export interface FactSummarizerPort {
  summarize(messages: readonly SummarizableMessage[]): Promise<readonly SummarizedFact[]>;
}

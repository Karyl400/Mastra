export interface PinnedFact {
  readonly id: string;
  readonly slackUserId: string;
  readonly fact: string;
  readonly createdAt: Date;
}

export interface PinnedFactRepository {
  list(slackUserId: string, limit: number): Promise<PinnedFact[]>;

  pin(fact: PinnedFact, max: number): Promise<void>;

  forget(slackUserId: string): Promise<number>;
}

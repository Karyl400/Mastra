export type SlackEventDedupStatus = 'in-flight' | 'done';

export interface SlackEventClaimOptions {
  readonly inFlightGraceMs: number;
}

export type SlackEventClaim =
  | { readonly granted: true; readonly reclaimed: boolean }
  | {
      readonly granted: false;
      readonly status: SlackEventDedupStatus | 'unknown';
      readonly ageMs: number | null;
    };

export const SLACK_EVENT_DEDUP_RETENTION_MS = 10 * 60 * 1000;

export interface SlackEventDedupRepository {
  claim(key: string, options: SlackEventClaimOptions): Promise<SlackEventClaim>;

  markDone(key: string): Promise<void>;

  release(key: string): Promise<void>;

  prune(olderThan: Date): Promise<number>;
}

export interface RateLimitRepository {
  increment(key: string, windowStart: Date, expiresAt: Date, by?: number): Promise<number>;

  prune(now: Date): Promise<number>;
}

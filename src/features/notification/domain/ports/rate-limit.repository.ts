export interface RateLimitRepository {
  increment(key: string, windowStart: Date, expiresAt: Date, by?: number): Promise<number>;

  pruneExpired(now: Date): Promise<number>;
}

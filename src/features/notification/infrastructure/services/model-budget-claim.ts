import type { LRUCache } from 'lru-cache';
import type { RateLimitRepository } from '../../domain/ports/rate-limit.repository';
import {
  buildCounterKey,
  evaluateCount,
  windowBounds,
  type RateLimitRule,
} from '../../domain/services/rate-limit-policy';

export interface RateLimitCounters {
  readonly rules: readonly RateLimitRule[];
  readonly repository: RateLimitRepository | null;
  readonly local: LRUCache<string, number>;
  logDegradation(rule: RateLimitRule, error: unknown): void;
}

export async function claimModelBudget(
  self: RateLimitCounters,
  subjectId: string,
  now: Date,
): Promise<{ allowed: boolean; degraded: boolean }> {
  const rules = self.rules.filter((rule) => rule.rationsModelBudget);
  if (rules.length === 0) return { allowed: true, degraded: false };

  const outcomes = await Promise.all(
    rules.map(async (rule) => claimOneRule(self, rule, subjectId, now)),
  );

  const refused = outcomes.filter((o) => !o.allowed);
  const degraded = outcomes.some((o) => o.degraded);

  if (refused.length === 0) return { allowed: true, degraded };

  await Promise.all(
    outcomes
      .filter((o) => o.claimed)
      .map(async (o) => releaseOneRule(self, o.rule, subjectId, now)),
  );

  return { allowed: false, degraded };
}

async function claimOneRule(
  self: RateLimitCounters,
  rule: RateLimitRule,
  subjectId: string,
  now: Date,
): Promise<{ rule: RateLimitRule; allowed: boolean; degraded: boolean; claimed: boolean }> {
  const key = buildCounterKey(rule, subjectId, now);
  const localCount = (self.local.get(key) ?? 0) + 1;
  self.local.set(key, localCount, { ttl: rule.windowMs });

  if (!self.repository) {
    return {
      rule,
      allowed: evaluateCount(rule, localCount).allowed,
      degraded: false,
      claimed: false,
    };
  }

  const { windowStart, expiresAt } = windowBounds(rule, now);
  try {
    const count = await self.repository.increment(key, windowStart, expiresAt, 1);
    return { rule, allowed: evaluateCount(rule, count).allowed, degraded: false, claimed: true };
  } catch (error) {
    self.logDegradation(rule, error);
    return { rule, allowed: true, degraded: true, claimed: false };
  }
}

async function releaseOneRule(
  self: RateLimitCounters,
  rule: RateLimitRule,
  subjectId: string,
  now: Date,
): Promise<void> {
  const key = buildCounterKey(rule, subjectId, now);
  self.local.set(key, Math.max(0, (self.local.get(key) ?? 1) - 1), { ttl: rule.windowMs });

  if (!self.repository) return;
  const { windowStart, expiresAt } = windowBounds(rule, now);
  try {
    await self.repository.increment(key, windowStart, expiresAt, -1);
  } catch (error) {
    self.logDegradation(rule, error);
  }
}

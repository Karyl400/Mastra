import { LRUCache } from 'lru-cache';
import { logger } from '../../../../shared/logger';
import type { RateLimitRepository } from '../../domain/ports/rate-limit.repository';
import {
  BURST_RULE,
  DAILY_RULE,
  WORKSPACE_SUBJECT,
  WORKSPACE_TOKEN_RULE,
  buildCounterKey,
  evaluateCount,
  windowBounds,
  type RateLimitRule,
} from '../../domain/services/rate-limit-policy';

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly rule: string | null;
  readonly shouldNotify: boolean;
  readonly degraded: boolean;
  readonly rationsModelBudget: boolean;
}

const ALLOWED: RateLimitDecision = {
  allowed: true,
  rule: null,
  shouldNotify: false,
  degraded: false,
  rationsModelBudget: false,
};

export interface SlackRateLimiterOptions {
  readonly rules?: readonly RateLimitRule[];
  readonly repository?: RateLimitRepository | null;
  readonly localMax?: number;
  readonly workspaceRule?: RateLimitRule | null;
}

export class SlackRateLimiter {
  private readonly rules: readonly RateLimitRule[];
  private readonly repository: RateLimitRepository | null;
  private readonly workspaceRule: RateLimitRule | null;
  private readonly local: LRUCache<string, number>;
  private degradationLogged = false;
  private readonly notifiedWindows = new Set<string>();

  constructor(options: SlackRateLimiterOptions = {}) {
    this.rules = options.rules ?? [BURST_RULE, DAILY_RULE];
    this.repository = options.repository ?? null;
    this.workspaceRule =
      options.workspaceRule === undefined ? WORKSPACE_TOKEN_RULE : options.workspaceRule;
    this.local = new LRUCache<string, number>({
      max: options.localMax ?? 5000,
      ttl: DAILY_RULE.windowMs,
    });
  }

  async check(
    subjectId: string,
    now: Date = new Date(),
    options: { answeredWithoutModel?: boolean; reserveOnly?: boolean } = {},
  ): Promise<RateLimitDecision> {
    const applicable = options.answeredWithoutModel
      ? this.rules.filter((rule) => !rule.rationsModelBudget)
      : this.rules;

    const local = this.checkLocalCounters(applicable, subjectId, now, options);
    if (local.refusal) return local.refusal;
    const pending = local.pending;

    const workspaceRule = this.workspaceRule;
    const workspaceApplies =
      workspaceRule !== null && !(options.answeredWithoutModel && workspaceRule.rationsModelBudget);

    if (workspaceRule && workspaceApplies) {
      pending.unshift({
        rule: workspaceRule,
        key: buildCounterKey(workspaceRule, WORKSPACE_SUBJECT, now),
        by: 0,
        projected: false,
      });
    }

    if (pending.length === 0) return ALLOWED;

    const repository = this.repository;
    if (!repository) return { ...ALLOWED, degraded: true };

    const outcomes = await Promise.all(
      pending.map(async ({ rule, key, by, projected }) => {
        const { windowStart, expiresAt } = windowBounds(rule, now);
        try {
          const read = await repository.increment(key, windowStart, expiresAt, by);
          return { rule, key, count: read + (projected ? 1 : 0) };
        } catch (error) {
          this.logDegradation(rule, error);
          return { rule, key, count: undefined };
        }
      }),
    );

    return this.readSharedVerdicts(outcomes);
  }

  private checkLocalCounters(
    applicable: readonly RateLimitRule[],
    subjectId: string,
    now: Date,
    options: { reserveOnly?: boolean },
  ): {
    refusal?: RateLimitDecision;
    pending: { rule: RateLimitRule; key: string; by: number; projected: boolean }[];
  } {
    const pending: { rule: RateLimitRule; key: string; by: number; projected: boolean }[] = [];

    for (const rule of applicable) {
      const key = buildCounterKey(rule, subjectId, now);

      const reserve = options.reserveOnly === true && rule.rationsModelBudget === true;

      const localCount = (this.local.get(key) ?? 0) + 1;
      if (!reserve) this.local.set(key, localCount, { ttl: rule.windowMs });

      const localVerdict = evaluateCount(rule, localCount);
      if (!localVerdict.allowed) {
        return {
          refusal: {
            allowed: false,
            rule: rule.name,
            shouldNotify: localVerdict.shouldNotify && this.claimNotification(key),
            degraded: false,
            rationsModelBudget: rule.rationsModelBudget === true,
          },
          pending,
        };
      }

      pending.push({ rule, key, by: reserve ? 0 : 1, projected: reserve });
    }

    return { pending };
  }

  private readSharedVerdicts(
    outcomes: readonly { rule: RateLimitRule; key: string; count: number | undefined }[],
  ): RateLimitDecision {
    let degraded = false;

    for (const { rule, key, count } of outcomes) {
      if (count === undefined) {
        degraded = true;
        continue;
      }

      const verdict = evaluateCount(rule, count);
      if (!verdict.allowed) {
        return {
          allowed: false,
          rule: rule.name,
          shouldNotify: this.claimNotification(key),
          degraded,
          rationsModelBudget: rule.rationsModelBudget === true,
        };
      }
    }

    return degraded ? { ...ALLOWED, degraded: true } : ALLOWED;
  }

  async consumeModelBudget(subjectId: string, now: Date = new Date()): Promise<void> {
    const rules = this.rules.filter((rule) => rule.rationsModelBudget);
    if (rules.length === 0) return;

    await Promise.all(
      rules.map(async (rule) => {
        const key = buildCounterKey(rule, subjectId, now);
        this.local.set(key, (this.local.get(key) ?? 0) + 1, { ttl: rule.windowMs });

        if (!this.repository) return;
        const { windowStart, expiresAt } = windowBounds(rule, now);
        try {
          await this.repository.increment(key, windowStart, expiresAt, 1);
        } catch (error) {
          this.logDegradation(rule, error);
        }
      }),
    );
  }

  async consumeTokens(tokens: number | null | undefined, now: Date = new Date()): Promise<void> {
    const rule = this.workspaceRule;
    if (!rule || !this.repository) return;
    if (!Number.isFinite(tokens ?? NaN) || (tokens ?? 0) <= 0) return;

    const key = buildCounterKey(rule, WORKSPACE_SUBJECT, now);
    const { windowStart, expiresAt } = windowBounds(rule, now);

    try {
      const consumed = await this.repository.increment(key, windowStart, expiresAt, tokens ?? 0);
      logger.info('Workspace token budget', { consumed, limit: rule.limit });
    } catch (error) {
      logger.warn('Could not record token consumption', { error });
    }
  }

  private claimNotification(key: string): boolean {
    if (this.notifiedWindows.has(key)) return false;
    this.notifiedWindows.add(key);
    return true;
  }

  private logDegradation(rule: RateLimitRule, error: unknown): void {
    if (this.degradationLogged) return;
    this.degradationLogged = true;
    logger.error('Shared rate limit unavailable — falling back to the per-instance counter', {
      error,
      rule: rule.name,
    });
  }

  async prune(now: Date = new Date()): Promise<void> {
    if (!this.repository) return;

    try {
      const removed = await this.repository.prune(now);
      if (removed > 0) logger.info('Pruned expired rate limit windows', { removed });
    } catch (error) {
      logger.warn('Rate limit pruning failed', { error });
    }
  }
}

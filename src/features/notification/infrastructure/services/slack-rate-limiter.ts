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
import {
  ALLOWED,
  type PendingCounter,
  type RateLimitDecision,
  type SlackRateLimiterOptions,
} from './rate-limit-decision';
import { claimModelBudget, type RateLimitCounters } from './model-budget-claim';
import { consumeWorkspaceTokens } from './workspace-token-budget';

export class SlackRateLimiter implements RateLimitCounters {
  readonly rules: readonly RateLimitRule[];
  readonly repository: RateLimitRepository | null;
  private readonly workspaceRule: RateLimitRule | null;
  readonly local: LRUCache<string, number>;
  private degradationLogged = false;
  private readonly notifiedWindows: LRUCache<string, true>;

  constructor(options: SlackRateLimiterOptions = {}) {
    this.rules = options.rules ?? [BURST_RULE, DAILY_RULE];
    this.repository = options.repository ?? null;
    this.workspaceRule =
      options.workspaceRule === undefined ? WORKSPACE_TOKEN_RULE : options.workspaceRule;
    this.notifiedWindows = new LRUCache<string, true>({
      max: options.localMax ?? 5000,
      ttl: DAILY_RULE.windowMs,
    });
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
    if (local.refusal) {
      return local.refusal;
    }
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

    if (pending.length === 0) {
      return ALLOWED;
    }

    const repository = this.repository;
    if (!repository) {
      return { ...ALLOWED, degraded: true };
    }

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
  ): { refusal?: RateLimitDecision; pending: PendingCounter[] } {
    const pending: PendingCounter[] = [];

    for (const rule of applicable) {
      const key = buildCounterKey(rule, subjectId, now);

      const reserve = options.reserveOnly === true && rule.rationsModelBudget === true;

      const localCount = (this.local.get(key) ?? 0) + 1;
      if (!reserve) {
        this.local.set(key, localCount, { ttl: rule.windowMs });
      }

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
    await this.claimModelBudget(subjectId, now);
  }

  async claimModelBudget(
    subjectId: string,
    now: Date = new Date(),
  ): Promise<{ allowed: boolean; degraded: boolean }> {
    return await claimModelBudget(this, subjectId, now);
  }

  async consumeTokens(tokens: number | null | undefined, now: Date = new Date()): Promise<void> {
    await consumeWorkspaceTokens(this.workspaceRule, this.repository, tokens, now);
  }

  private claimNotification(key: string): boolean {
    if (this.notifiedWindows.has(key)) {
      return false;
    }
    this.notifiedWindows.set(key, true);
    return true;
  }

  logDegradation(rule: RateLimitRule, error: unknown): void {
    logger.error('Shared rate limit unavailable — falling back to the per-instance counter', {
      error,
      rule: rule.name,
      firstInThisInstance: !this.degradationLogged,
    });
    this.degradationLogged = true;
  }

  async pruneExpired(now: Date = new Date()): Promise<void> {
    if (!this.repository) {
      return;
    }

    try {
      const removed = await this.repository.pruneExpired(now);
      if (removed > 0) {
        logger.info('Pruned expired rate limit windows', { removed });
      }
    } catch (error) {
      logger.warn('Rate limit pruning failed', { error });
    }
  }
}

export type { RateLimitDecision, SlackRateLimiterOptions } from './rate-limit-decision';

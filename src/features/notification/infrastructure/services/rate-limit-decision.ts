import type { RateLimitRepository } from '../../domain/ports/rate-limit.repository';
import type { RateLimitRule } from '../../domain/services/rate-limit-policy';

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly rule: string | null;
  readonly shouldNotify: boolean;
  readonly degraded: boolean;
  readonly rationsModelBudget: boolean;
}

export const ALLOWED: RateLimitDecision = {
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

export interface PendingCounter {
  rule: RateLimitRule;
  key: string;
  by: number;
  projected: boolean;
}

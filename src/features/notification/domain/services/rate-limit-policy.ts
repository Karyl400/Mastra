export interface RateLimitRule {
  readonly name: string;
  readonly limit: number;
  readonly windowMs: number;
  readonly rationsModelBudget?: boolean;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const BURST_RULE: RateLimitRule = {
  name: 'burst',
  limit: 5,
  windowMs: MINUTE_MS,
};

export const DAILY_RULE: RateLimitRule = {
  name: 'daily',
  limit: 200,
  windowMs: DAY_MS,
  rationsModelBudget: true,
};

export const WORKSPACE_SUBJECT = 'workspace';

export const WORKSPACE_TOKEN_RULE: RateLimitRule = {
  name: 'workspaceTokens',
  limit: 4_000_000,
  windowMs: DAY_MS,
  rationsModelBudget: true,
};

const EXPIRY_MARGIN_MS = 5 * MINUTE_MS;

export interface WindowBounds {
  readonly windowStart: Date;
  readonly expiresAt: Date;
}

export function windowBounds(rule: RateLimitRule, now: Date): WindowBounds {
  const index = Math.floor(now.getTime() / rule.windowMs);
  const start = index * rule.windowMs;

  return {
    windowStart: new Date(start),
    expiresAt: new Date(start + rule.windowMs + EXPIRY_MARGIN_MS),
  };
}

export function buildCounterKey(rule: RateLimitRule, subjectId: string, now: Date): string {
  const index = Math.floor(now.getTime() / rule.windowMs);
  return `${rule.name}:${subjectId.length}:${subjectId}:${index}`;
}

export interface RateLimitEvaluation {
  readonly allowed: boolean;
  readonly shouldNotify: boolean;
}

export function evaluateCount(rule: RateLimitRule, count: number): RateLimitEvaluation {
  if (!Number.isFinite(count) || count <= 0) {
    return { allowed: true, shouldNotify: false };
  }

  return {
    allowed: count <= rule.limit,
    shouldNotify: count > rule.limit,
  };
}

export function readRuleLimit(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((raw ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

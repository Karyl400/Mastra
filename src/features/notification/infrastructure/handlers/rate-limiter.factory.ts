import { DrizzleRateLimitRepository } from '../repositories/drizzle-rate-limit.repository';
import { SlackRateLimiter } from '../services/slack-rate-limiter';
import {
  BURST_RULE,
  DAILY_RULE,
  WORKSPACE_TOKEN_RULE,
  readRuleLimit,
} from '../../domain/services/rate-limit-policy';

export function buildRateLimiter(): SlackRateLimiter {
  return new SlackRateLimiter({
    repository: new DrizzleRateLimitRepository(),
    rules: [
      { ...BURST_RULE, limit: readRuleLimit(process.env.SLACK_BURST_LIMIT, BURST_RULE.limit) },
      { ...DAILY_RULE, limit: readRuleLimit(process.env.SLACK_DAILY_LIMIT, DAILY_RULE.limit) },
    ],
    workspaceRule: {
      ...WORKSPACE_TOKEN_RULE,
      limit: readRuleLimit(process.env.SLACK_WORKSPACE_TOKEN_BUDGET, WORKSPACE_TOKEN_RULE.limit),
    },
  });
}

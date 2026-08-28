import { logger } from '../../../../shared/logger';
import type { RateLimitRepository } from '../../domain/ports/rate-limit.repository';
import {
  WORKSPACE_SUBJECT,
  buildCounterKey,
  windowBounds,
  type RateLimitRule,
} from '../../domain/services/rate-limit-policy';

export async function consumeWorkspaceTokens(
  rule: RateLimitRule | null,
  repository: RateLimitRepository | null,
  tokens: number | null | undefined,
  now: Date,
): Promise<void> {
  if (!rule || !repository) return;
  if (!Number.isFinite(tokens ?? NaN) || (tokens ?? 0) <= 0) return;

  const key = buildCounterKey(rule, WORKSPACE_SUBJECT, now);
  const { windowStart, expiresAt } = windowBounds(rule, now);

  try {
    const consumed = await repository.increment(key, windowStart, expiresAt, tokens ?? 0);
    logger.info('Workspace token budget', { consumed, limit: rule.limit });
  } catch (error) {
    logger.warn('Could not record token consumption', { error });
  }
}

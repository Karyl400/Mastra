import { logger } from '../../../../shared/logger';
import { SLACK_EVENT_DEDUP_RETENTION_MS } from '../../domain/ports/slack-event-dedup.repository';
import type { SlackHandlerInternals } from './handler-internals';
import { isTeamJoinEvent, type SlackEventEnvelope } from './slack-event.types';
import { pruneIsDue } from './conversation-memory';

export const DEFAULT_IN_FLIGHT_GRACE_MS = 60_000;

export function dedupKey(envelope: SlackEventEnvelope): string | undefined {
  const event = envelope.event;

  if (event && !isTeamJoinEvent(event)) {
    const { channel, ts } = event;
    if (channel && ts) return `ts:${channel}:${ts}`;
  }

  if (envelope.event_id) return `id:${envelope.event_id}`;
  return undefined;
}

export async function claimEvent(
  self: SlackHandlerInternals,
  key: string,
  retryNum?: string | null,
): Promise<boolean> {
  const local = claimLocally(self, key, retryNum);
  if (!local) return false;

  const repo = self.getDedupRepo();
  if (!repo) return true;

  try {
    const claim = await repo.claim(key, { inFlightGraceMs: self.inFlightGraceMs });

    if (!claim.granted) {
      self.seenEvents.delete(key);
      logger.info('Dropping duplicate Slack event (claimed by another instance)', {
        key,
        status: claim.status,
        ageMs: claim.ageMs,
        retryNum: retryNum ?? undefined,
      });
      return false;
    }

    if (claim.reclaimed) {
      logger.warn('Reprocessing an abandoned Slack event (shared claim)', {
        key,
        retryNum: retryNum ?? undefined,
      });
    }

    return true;
  } catch (error) {
    logger.error('Shared Slack dedup unavailable — falling back to the per-instance cache', {
      error,
      key,
      retryNum: retryNum ?? undefined,
    });
    return true;
  }
}

function claimLocally(self: SlackHandlerInternals, key: string, retryNum?: string | null): boolean {
  const existing = self.seenEvents.get(key);

  if (existing) {
    const ageMs = Date.now() - existing.startedAt;
    const abandoned = existing.status === 'in-flight' && ageMs >= self.inFlightGraceMs;

    if (!abandoned) {
      logger.info('Dropping duplicate Slack event', {
        key,
        status: existing.status,
        ageMs,
        retryNum: retryNum ?? undefined,
      });
      return false;
    }

    logger.warn('Reprocessing abandoned Slack event', {
      key,
      ageMs,
      retryNum: retryNum ?? undefined,
    });
  }

  self.seenEvents.set(key, { status: 'in-flight', startedAt: Date.now() });
  return true;
}

export async function markDedupDone(
  self: SlackHandlerInternals,
  key: string | undefined,
): Promise<void> {
  if (!key) return;
  self.seenEvents.set(key, { status: 'done', startedAt: Date.now() });

  const repo = self.getDedupRepo();
  if (!repo) return;
  try {
    await repo.markDone(key);
  } catch (error) {
    logger.warn('Unable to mark the shared Slack dedup key as done', { error, key });
  }
}

export async function releaseDedup(
  self: SlackHandlerInternals,
  key: string | undefined,
): Promise<void> {
  if (!key) return;
  self.seenEvents.delete(key);

  const repo = self.getDedupRepo();
  if (!repo) return;
  try {
    await repo.release(key);
  } catch (error) {
    logger.warn('Unable to release the shared Slack dedup key', { error, key });
  }
}

export function scheduleDedupPruneIfDue(self: SlackHandlerInternals): void {
  if (!pruneIsDue(self)) return;

  const repo = self.getDedupRepo();
  if (!repo) return;

  void repo
    .pruneOlderThan(new Date(Date.now() - SLACK_EVENT_DEDUP_RETENTION_MS))
    .then((removed) => logger.info('Pruned expired Slack dedup keys', { removed }))
    .catch((error) => logger.warn('Slack dedup prune failed', { error }));
}

import type { SlackHandlerInternals } from './handler-internals';
import {
  isTeamJoinEvent,
  type SlackAcceptContext,
  type SlackEventDecision,
  type SlackEventEnvelope,
} from './slack-event.types';
import { claimEvent, dedupKey } from './event-dedup';
import {
  SUPPORTED_EVENT_TYPES,
  checkTeamId,
  isStale,
  rejectMessage,
  rejectTeamJoin,
} from './event-gating';
import { checkRateLimit } from './rate-limit-gate';

export async function acceptEvent(
  self: SlackHandlerInternals,
  envelope: SlackEventEnvelope,
  context: SlackAcceptContext = {},
): Promise<SlackEventDecision> {
  if (envelope.type !== 'event_callback') {
    return { action: 'ignore', reason: 'not_event_callback' };
  }

  const event = envelope.event;
  if (!event) {
    return { action: 'ignore', reason: 'no_event' };
  }

  if (!event.type || !SUPPORTED_EVENT_TYPES.has(event.type)) {
    return { action: 'ignore', reason: 'unsupported_event_type' };
  }

  const wrongTeam = checkTeamId(self, envelope);
  if (wrongTeam) return wrongTeam;

  const rejected = isTeamJoinEvent(event) ? rejectTeamJoin(event) : rejectMessage(event);
  if (rejected) return { action: 'ignore', reason: rejected };

  if (isStale(envelope, event)) {
    return { action: 'ignore', reason: 'stale_event' };
  }

  const key = dedupKey(envelope);
  if (key && !(await claimEvent(self, key, context.retryNum))) {
    return { action: 'ignore', reason: 'duplicate' };
  }

  const limited = await checkRateLimit(self, event);
  if (limited) return limited;

  return { action: 'process', event };
}

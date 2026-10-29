import { judgeWorkspace } from '../../../../shared/slack-team';
import { logger } from '../../../../shared/logger';
import { FILE_SHARE_SUBTYPE } from '../../domain/services/deterministic-replies';
import type { SlackHandlerInternals } from './handler-internals';
import { cleanText } from './message-text';
import {
  SLACKBOT_USER_ID,
  isTeamJoinEvent,
  type SlackEvent,
  type SlackEventDecision,
  type SlackEventEnvelope,
  type SlackIgnoreReason,
  type SlackMessageEvent,
  type SlackTeamJoinEvent,
} from './slack-event.types';

export const SUPPORTED_EVENT_TYPES = new Set(['app_mention', 'message', 'team_join']);

export const MAX_EVENT_AGE_MS = 10 * 60 * 1000;

export function isStale(envelope: SlackEventEnvelope, event: SlackEvent): boolean {
  if (isTeamJoinEvent(event)) {
    return false;
  }

  const emittedAtSeconds = envelope.event_time;
  if (!Number.isFinite(emittedAtSeconds) || (emittedAtSeconds ?? 0) <= 0) {
    return false;
  }

  const ageMs = Date.now() - (emittedAtSeconds as number) * 1000;
  if (ageMs < MAX_EVENT_AGE_MS) {
    return false;
  }

  logger.warn('Dropping a stale Slack event — answering it now would land out of context', {
    ageMs,
    channel: event.channel,
    type: event.type,
  });

  return true;
}

export function checkTeamId(
  self: SlackHandlerInternals,
  envelope: SlackEventEnvelope,
): SlackEventDecision | undefined {
  const verdict = judgeWorkspace(envelope.team_id, process.env.SLACK_TEAM_ID);

  if (verdict.accepted) {
    if (!verdict.checked && !self.teamIdWarningEmitted) {
      self.teamIdWarningEmitted = true;
      logger.warn(
        'SLACK_TEAM_ID is not set — cross-workspace check disabled (fail-open by design)',
      );
    }
    return undefined;
  }

  logger.warn('Dropping Slack event from an unexpected workspace', {
    received: verdict.received,
    expected: verdict.expected,
  });
  return { action: 'ignore', reason: 'wrong_team' };
}

export function rejectMessage(event: SlackMessageEvent): SlackIgnoreReason | undefined {
  if (event.type === 'message' && event.channel_type !== 'im') {
    const isThreadReply = Boolean(event.thread_ts) && event.thread_ts !== event.ts;
    if (!isThreadReply) {
      return 'not_a_dm';
    }
  }

  if (event.type === 'app_mention' && event.channel?.startsWith('D')) {
    return 'duplicate_mention';
  }

  if (event.bot_id || event.subtype === 'bot_message' || event.bot_profile) {
    return 'bot_message';
  }

  if (event.type === 'message' && event.subtype && event.subtype !== FILE_SHARE_SUBTYPE) {
    return 'unsupported_event_type';
  }

  if (event.subtype !== FILE_SHARE_SUBTYPE && !cleanText(event.text)) {
    return 'empty_text';
  }

  return undefined;
}

export function rejectTeamJoin(event: SlackTeamJoinEvent): SlackIgnoreReason | undefined {
  const user = event.user;

  if (!user?.id) {
    return 'no_user';
  }

  if (user.is_bot || user.is_app_user || user.is_workflow_bot || user.id === SLACKBOT_USER_ID) {
    return 'bot_join';
  }

  if (user.deleted) {
    return 'deleted_user';
  }

  if (user.is_ultra_restricted || user.is_stranger) {
    return 'restricted_user';
  }

  return undefined;
}

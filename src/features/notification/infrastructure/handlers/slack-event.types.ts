export interface SlackMessageEvent {
  type?: string;
  subtype?: string;
  text?: string;
  user?: string;
  channel?: string;
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  app_id?: string;
  bot_profile?: unknown;
}

export interface SlackTeamJoinUser {
  id?: string;
  name?: string;
  real_name?: string;
  is_bot?: boolean;
  is_app_user?: boolean;
  is_workflow_bot?: boolean;
  deleted?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  is_stranger?: boolean;
  profile?: {
    email?: string;
    first_name?: string;
    last_name?: string;
    real_name?: string;
  };
}

export interface SlackTeamJoinEvent {
  type: 'team_join';
  user?: SlackTeamJoinUser;
  event_ts?: string;
}

export type SlackEvent = SlackTeamJoinEvent | SlackMessageEvent;

export function isTeamJoinEvent(event: SlackEvent): event is SlackTeamJoinEvent {
  return event.type === 'team_join';
}

export interface SlackEventEnvelope {
  type?: string;
  token?: string;
  challenge?: string;
  team_id?: string;
  api_app_id?: string;
  event_id?: string;
  event_time?: number;
  event?: SlackEvent;
}

export type SlackEventDecision =
  { action: 'process'; event: SlackEvent } | { action: 'ignore'; reason: SlackIgnoreReason };

export type SlackIgnoreReason =
  | 'not_event_callback'
  | 'no_event'
  | 'unsupported_event_type'
  | 'not_a_dm'
  | 'bot_message'
  | 'duplicate'
  | 'empty_text'
  | 'wrong_team'
  | 'no_user'
  | 'bot_join'
  | 'deleted_user'
  | 'restricted_user'
  | 'duplicate_mention'
  | 'stale_event'
  | 'rate_limited';

export interface SlackAcceptContext {
  retryNum?: string | null;
}

export const SLACKBOT_USER_ID = 'USLACKBOT';

export function resolveThreadTarget(
  event: SlackMessageEvent,
  channel: string,
): { isDirectMessage: boolean; threadTs?: string } {
  const isDirectMessage = event.channel_type === 'im' || channel.startsWith('D');
  const isAlreadyThreaded = Boolean(event.thread_ts) && event.thread_ts !== event.ts;

  if (!isDirectMessage) return { isDirectMessage, threadTs: event.thread_ts ?? event.ts };
  return { isDirectMessage, threadTs: isAlreadyThreaded ? event.thread_ts : undefined };
}

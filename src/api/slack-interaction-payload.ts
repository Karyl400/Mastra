import { type NewcomerIdentity } from '../features/onboarding/domain/services/newcomer-identity';

export interface SlackInteractionUser {
  id?: string;
  name?: string;
}

export interface SlackBlockAction {
  action_id?: string;
  value?: string;
}

export interface SlackInteractionPayload {
  type?: string;
  trigger_id?: string;
  user?: SlackInteractionUser;
  team?: { id?: string };
  actions?: SlackBlockAction[];
  view?: {
    callback_id?: string;
    private_metadata?: string;
  };
  channel?: { id?: string };
  message?: { ts?: string; thread_ts?: string };
}

export function decodeLegacyProfileButton(
  value: string | undefined,
  fallbackUserId = '',
): NewcomerIdentity {
  if (!value) {
    return { slackUserId: fallbackUserId };
  }

  try {
    const parsed = JSON.parse(value) as {
      u?: string;
      e?: string;
      f?: string;
      l?: string;
      j?: string;
    };
    return {
      slackUserId: parsed.u || fallbackUserId,
      email: parsed.e ?? null,
      firstName: parsed.f ?? null,
      lastName: parsed.l ?? null,
      joinedAt: parsed.j ?? null,
    };
  } catch {
    return { slackUserId: value || fallbackUserId };
  }
}

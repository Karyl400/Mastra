import {
  resolveAccess,
  type AccessSubject,
} from '../../../directory/domain/services/access-policy';

export type DisclosureReason =
  | 'ok_self'
  | 'ok_manager'
  | 'ok_channel_member'
  | 'no_requester'
  | 'requester_denied'
  | 'insufficient_privilege'
  | 'not_channel_member';

export interface DisclosureVerdict {
  readonly allowed: boolean;
  readonly reason: DisclosureReason;
}

export interface Requester {
  readonly slackUserId: string;
  readonly subject: AccessSubject | null;
}

const DENIED_LEVEL = 'denied';

function hardDenial(requester: Requester): DisclosureVerdict | null {
  if (!requester.subject) return null;
  const decision = resolveAccess(requester.subject);
  return decision.level === DENIED_LEVEL ? { allowed: false, reason: 'requester_denied' } : null;
}

function isSamePerson(a: string, b: string): boolean {
  return a.trim() === b.trim() && a.trim().length > 0;
}

export function authorizeMemoryRead(
  requester: Requester | null,
  targetSlackUserId: string,
): DisclosureVerdict {
  if (!requester) return { allowed: false, reason: 'no_requester' };

  const denial = hardDenial(requester);
  if (denial) return denial;

  if (isSamePerson(requester.slackUserId, targetSlackUserId)) {
    return { allowed: true, reason: 'ok_self' };
  }

  return authorizeOtherMemoryRead(requester);
}

export function authorizeOtherMemoryRead(requester: Requester | null): DisclosureVerdict {
  if (!requester) return { allowed: false, reason: 'no_requester' };

  const denial = hardDenial(requester);
  if (denial) return denial;

  if (!requester.subject) return { allowed: false, reason: 'insufficient_privilege' };

  const decision = resolveAccess(requester.subject);
  return decision.level === 'full'
    ? { allowed: true, reason: 'ok_manager' }
    : { allowed: false, reason: 'insufficient_privilege' };
}

export function mayDiscloseBotUtterances(
  requester: Requester | null,
  targetSlackUserId: string,
): boolean {
  if (!requester) return false;
  return isSamePerson(requester.slackUserId, targetSlackUserId);
}

export function authorizeChannelRead(
  requester: Requester | null,
  requesterIsChannelMember: boolean,
): DisclosureVerdict {
  if (!requester) return { allowed: false, reason: 'no_requester' };

  const denial = hardDenial(requester);
  if (denial) return denial;

  return requesterIsChannelMember
    ? { allowed: true, reason: 'ok_channel_member' }
    : { allowed: false, reason: 'not_channel_member' };
}

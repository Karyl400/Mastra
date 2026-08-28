import type { SlackMember } from '../../domain/ports/slack-workspace.port';
import { SLACK_MAX_PAGES } from '../../domain/ports/slack-workspace.port';
import { logger } from '../../../../shared/logger';

export interface SlackApiUser {
  id?: string;
  name?: string;
  real_name?: string | null;
  is_bot?: boolean;
  is_admin?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  deleted?: boolean;
  team_id?: string;
  profile?: {
    email?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    display_name?: string | null;
    real_name?: string | null;
    title?: string | null;
  };
}

function splitRealName(realName: string): { firstName: string; lastName: string } {
  const [first, ...rest] = realName.trim().split(/\s+/).filter(Boolean);
  return { firstName: first ?? '', lastName: rest.join(' ') };
}

export function toMember(user: SlackApiUser): SlackMember {
  const realName = user.real_name || '';
  const derived = splitRealName(realName);

  return {
    id: user.id ?? '',
    name: user.name ?? '',
    realName,
    email: user.profile?.email ?? null,
    firstName: user.profile?.first_name || derived.firstName,
    lastName: user.profile?.last_name || derived.lastName,
    displayName:
      user.profile?.display_name || user.profile?.real_name || realName || user.name || '',
    title: user.profile?.title || '',
    isBot: user.is_bot ?? false,
    isAdmin: user.is_admin ?? false,
    isRestricted: user.is_restricted ?? false,
    isUltraRestricted: user.is_ultra_restricted ?? false,
    isDeleted: user.deleted ?? false,
    teamId: user.team_id ?? '',
  };
}

export function logTruncation(method: string, pages: number, collected: number): void {
  logger.error('Slack pagination cap reached — the result is TRUNCATED', {
    method,
    pages,
    collected,
    cap: SLACK_MAX_PAGES,
  });
}

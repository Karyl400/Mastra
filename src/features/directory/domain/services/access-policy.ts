export type AccessLevel = 'denied' | 'readonly' | 'full';

export type AccessReason =
  'manager' | 'not_a_manager' | 'guest' | 'unknown_actor' | 'bot_actor' | 'deactivated_account';

export interface AccessDecision {
  readonly level: AccessLevel;
  readonly reason: AccessReason;
}

export interface AccessSubject {
  readonly slackUserId: string;
  readonly email: string | null;
  readonly isBot: boolean;
  readonly isRestricted: boolean;
  readonly isUltraRestricted: boolean;
  readonly isDeleted: boolean;
  readonly isManager: boolean;
}

export function resolveAccess(subject: AccessSubject | null): AccessDecision {
  if (!subject) return { level: 'readonly', reason: 'unknown_actor' };

  if (subject.isBot) return { level: 'denied', reason: 'bot_actor' };
  if (subject.isDeleted) return { level: 'denied', reason: 'deactivated_account' };

  if (subject.isRestricted || subject.isUltraRestricted) {
    return { level: 'readonly', reason: 'guest' };
  }

  return subject.isManager
    ? { level: 'full', reason: 'manager' }
    : { level: 'readonly', reason: 'not_a_manager' };
}

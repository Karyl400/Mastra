import { logger } from '../../../../shared/logger';
import { AUDIT_ACTIONS } from '../../../../shared/audit-actions';
import type { SlackAccessLevel } from '../../../../shared/slack-request-context';
import {
  EMPTY_IDENTITY,
  sanitizeDisplayName,
  type RequesterIdentity,
} from '../../domain/services/context-preamble';
import type { SlackHandlerInternals } from './handler-internals';

export async function resolveRequesterIdentity(
  self: SlackHandlerInternals,
  slackUserId: string | undefined,
): Promise<RequesterIdentity> {
  if (!slackUserId) {
    return EMPTY_IDENTITY;
  }

  const cached = self.requesterNames.get(slackUserId);
  if (cached !== undefined) {
    return cached;
  }

  let resolved: RequesterIdentity = EMPTY_IDENTITY;

  try {
    const known = await self.getDirectoryRepo()?.findBySlackUserId(slackUserId);

    if (known) {
      resolved = {
        displayName: sanitizeDisplayName(
          known.realName || [known.firstName, known.lastName].filter(Boolean).join(' '),
        ),
        email: known.email,
        employeeId: known.employeeId,
      };
    }
  } catch (error) {
    logger.debug('Directory lookup failed while resolving the requester identity', {
      slackUserId,
      error,
    });
  }

  if (!resolved.displayName) {
    try {
      const member = await self.workspaceProvider.findUserById(slackUserId);
      resolved = {
        ...resolved,
        displayName: sanitizeDisplayName(
          member?.realName || [member?.firstName, member?.lastName].filter(Boolean).join(' '),
        ),
        email: resolved.email ?? member?.email ?? null,
      };
    } catch (error) {
      logger.debug('Unable to resolve the Slack display name — falling back to the user id', {
        slackUserId,
        error,
      });
    }
  }

  self.requesterNames.set(slackUserId, resolved);
  return resolved;
}

function warnNoAccessGuardOnce(self: SlackHandlerInternals): void {
  if (self.noAccessGuardLogged) {
    return;
  }
  self.noAccessGuardLogged = true;
  logger.error(
    'No access guard is wired (directoryRepository missing) — authorization cannot be ' +
      "evaluated. Nobody will be able to read anyone else's record.",
  );
}

export async function evaluateAccess(
  self: SlackHandlerInternals,
  user: string | undefined,
): Promise<SlackAccessLevel | undefined> {
  if (!user) {
    return undefined;
  }

  const guard = self.getAccessGuard();
  if (!guard) {
    warnNoAccessGuardOnce(self);
    return undefined;
  }

  try {
    const evaluation = await guard.evaluate(user);
    return evaluation.effective;
  } catch (error) {
    logger.error('Access evaluation failed — falling back to no evaluation', { user, error });
    return undefined;
  }
}

export async function enforceAuthorization(
  self: SlackHandlerInternals,
  ctx: {
    user?: string;
    channel: string;
    threadTs?: string;
    isDirectMessage: boolean;
  },
): Promise<SlackAccessLevel | undefined | 'denied'> {
  const { user, channel, threadTs, isDirectMessage } = ctx;
  const accessLevel = await evaluateAccess(self, user);

  if (accessLevel !== 'denied') {
    return accessLevel;
  }

  logger.warn('Slack message refused by the authorization policy', { user, channel });
  void self.audit({
    action: AUDIT_ACTIONS.authzDenied,
    actorId: user ?? 'unknown',
    status: 'denied',
    details: { channel, isDirectMessage },
  });
  await self.slack.chat.postMessage({
    channel,
    text: "Je ne peux pas traiter cette demande. Rapproche-toi d'une personne de l'équipe.",
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });
  return 'denied';
}

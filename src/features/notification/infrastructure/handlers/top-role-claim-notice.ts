import { logger } from '../../../../shared/logger';
import { sanitizeDisplayName } from '../../domain/services/context-preamble';
import {
  declaresTopRole,
  topRoleClaimNotice,
  topRoleClaimReply,
} from '../../../onboarding/domain/services/top-role-claim';
import type { SlackHandlerInternals } from './handler-internals';
import { resolveRequesterIdentity } from './requester-identity';

export async function warnManagersOfTopRoleClaim(
  self: SlackHandlerInternals,
  slackUserId: string | undefined,
  position: string,
): Promise<string | null> {
  if (!slackUserId || !declaresTopRole(position)) {
    return null;
  }

  try {
    const repo = self.getDirectoryRepo();
    if (!repo) {
      return null;
    }

    const managers = (await repo.findManagers()).filter((m) => m.slackUserId !== slackUserId);

    if (managers.length === 0) {
      logger.warn('Poste au sommet déclaré, mais AUCUN manager à prévenir', {
        slackUserId,
        position,
      });
      return null;
    }

    const identity = await resolveRequesterIdentity(self, slackUserId);
    const notice = topRoleClaimNotice({
      newcomerName: identity.displayName ?? slackUserId,
      declaredPosition: position,
      slackUserId,
    });

    let informed = 0;
    for (const manager of managers) {
      try {
        await self.slack.chat.postMessage({ channel: manager.slackUserId, text: notice });
        informed += 1;
        logger.info('Manager prévenu d’une déclaration de poste au sommet', {
          managerId: manager.slackUserId,
        });
      } catch (error) {
        logger.error('DM au manager refusé — le déclarant ne doit pas croire l’inverse', {
          managerId: manager.slackUserId,
          error: String(error),
        });
      }
    }

    const holder = managers[0]!;
    return topRoleClaimReply({
      declaredPosition: position,
      holderName: sanitizeDisplayName(holder.displayName || holder.realName) || null,
      informed: informed > 0,
    });
  } catch (error) {
    logger.error('Impossible de prévenir le manager d’une déclaration de poste', {
      error: String(error),
    });
    return null;
  }
}

import { logger } from '../../../../shared/logger';
import { SlackAccessGuard } from '../../../directory/application/services/access-guard';
import type { DirectoryRepository } from '../../../directory/domain/ports/directory.repository';
import type { MemberSource } from '../../../directory/domain/ports/member-source';

const DIRECTORY_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export function buildAccessGuard(
  repo: DirectoryRepository | null,
  source: MemberSource,
): SlackAccessGuard | null {
  if (!repo) {
    return null;
  }

  return new SlackAccessGuard({
    resolveSubject: async (slackUserId) => {
      const known = await repo.findBySlackUserId(slackUserId);

      if (known) {
        if (Date.now() - known.syncedAt.getTime() > DIRECTORY_STALE_AFTER_MS) {
          void source
            .findById(slackUserId)
            .then((fresh) => (fresh ? repo.upsertFacts(fresh, new Date()) : undefined))
            .catch((error) =>
              logger.warn('Directory refresh failed — keeping the known facts', {
                slackUserId,
                error,
              }),
            );
        }

        return known;
      }

      const facts = await source.findById(slackUserId);
      if (!facts) {
        return null;
      }

      await repo.upsertFacts(facts, new Date()).catch((error) =>
        logger.warn('Could not persist the directory entry learned on the fly', {
          slackUserId,
          error,
        }),
      );

      return { ...facts, employeeId: null, isManager: false };
    },
    hasManager: () =>
      repo.hasManager().catch((error) => {
        logger.warn('Could not check for a designated manager', { error });
        return false;
      }),
  });
}

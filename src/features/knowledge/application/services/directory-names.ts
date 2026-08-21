import { sanitizeDisplayName } from '../../../notification/domain/services/context-preamble';
import { fullName } from '../../../../shared/name-matching';
import { mentionedUserIds, type NameLookup } from '../../domain/services/mention-names';
import { logger } from '../../../../shared/logger';

export interface NameSource {
  findBySlackUserId(slackUserId: string): Promise<{
    readonly realName?: string | null;
    readonly displayName?: string | null;
    readonly firstName?: string | null;
    readonly lastName?: string | null;
  } | null>;
}

export async function buildNameLookup(
  directory: NameSource | null | undefined,
  texts: readonly string[],
): Promise<NameLookup | undefined> {
  if (!directory) return undefined;

  const ids = mentionedUserIds(texts);
  if (ids.length === 0) return undefined;

  const names = new Map<string, string>();
  await Promise.all(
    ids.map(async (id) => {
      try {
        const member = await directory.findBySlackUserId(id);
        if (!member) return;
        const name =
          sanitizeDisplayName(member.realName) ||
          sanitizeDisplayName(member.displayName) ||
          fullName(sanitizeDisplayName(member.firstName), sanitizeDisplayName(member.lastName));
        if (name) names.set(id, name);
      } catch (error) {
        logger.warn('Mention non résolue — jeton laissé tel quel', {
          slackUserId: id,
          error: String(error),
        });
      }
    }),
  );

  if (names.size === 0) return undefined;
  return (id: string) => names.get(id.toUpperCase());
}

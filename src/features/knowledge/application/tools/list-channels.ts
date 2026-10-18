import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { logger } from '../../../../shared/logger';
import { readSlackContext } from '../../../../shared/slack-request-context';
import type { ChannelHistoryPort, ChannelRef } from '../../domain/ports/channel-history.port';
import type {
  DirectoryPerson,
  PersonDirectoryPort,
} from '../../domain/ports/person-directory.port';
import { refuse } from './channel-history-verdicts';

export interface ListChannelsDeps {
  readonly directory: PersonDirectoryPort;
  readonly channels: ChannelHistoryPort;
}

export const MAX_LISTED_CHANNELS = 40;

const SAFE_CHANNEL_NAME = /^[\p{L}\p{N}_.-]{1,80}$/u;

const OTHERS_HIDDEN_HINT =
  'Pour ce compte, seuls ses propres canaux sont listés. Ne dis rien des autres canaux, ni ' +
  "qu'il en existe.";

function mayBrowsePublicChannels(person: DirectoryPerson | null): boolean {
  if (!person) return false;
  return !person.isRestricted && !person.isUltraRestricted && !person.isDeleted && !person.isBot;
}

function namesOf(channels: readonly ChannelRef[]): { names: string[]; truncated: boolean } {
  const names = channels
    .map((channel) => channel.name)
    .filter((name) => SAFE_CHANNEL_NAME.test(name));
  return {
    names: names.slice(0, MAX_LISTED_CHANNELS),
    truncated: names.length > MAX_LISTED_CHANNELS,
  };
}

async function findRequester(
  directory: PersonDirectoryPort,
  slackUserId: string,
): Promise<DirectoryPerson | null> {
  try {
    return await directory.findBySlackUserId(slackUserId);
  } catch (error) {
    logger.warn('Knowledge — annuaire indisponible, demandeur traité comme inconnu', {
      requesterId: slackUserId,
      error,
    });
    return null;
  }
}

export function makeListChannels(deps: ListChannelsDeps) {
  return createTool({
    id: 'listChannels',
    description:
      "Liste les canaux Slack que la personne peut voir : ceux dont elle est membre, et les canaux publics qu'elle n'a pas rejoints. Ne lit aucun message.",
    inputSchema: z.object({}),
    execute: async (_data, ctx) => {
      const requesterId = readSlackContext(ctx?.requestContext)?.slackUserId;
      if (!requesterId) {
        logger.warn('Knowledge — liste des canaux refusée : aucun demandeur identifié');
        return refuse('no_requester');
      }

      const person = await findRequester(deps.directory, requesterId);
      const includePublicOthers = mayBrowsePublicChannels(person);

      let listing;
      try {
        listing = await deps.channels.listVisibleChannels(requesterId, {
          limit: 200,
          includePublicOthers,
        });
      } catch (error) {
        logger.error('Knowledge — liste des canaux impossible', { requesterId, error });
        return refuse('unavailable');
      }

      const mine = namesOf(listing.mine);
      if (!includePublicOthers) {
        return {
          found: true as const,
          mine: mine.names,
          ...(mine.truncated ? { truncated: true as const } : {}),
          hint: OTHERS_HIDDEN_HINT,
        };
      }

      const others = namesOf(listing.others);
      return {
        found: true as const,
        mine: mine.names,
        others: others.names,
        ...(mine.truncated || others.truncated ? { truncated: true as const } : {}),
      };
    },
  });
}

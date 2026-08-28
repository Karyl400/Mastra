import { logger } from '../../../../shared/logger';
import type { ChannelHistoryPort } from '../../domain/ports/channel-history.port';
import { resolveChannelName } from '../../domain/services/channel-name-matching';
import type { ChannelVerdict } from './channel-history-verdicts';

const CHANNEL_LOOKUP_LIMIT = 200;

export async function resolveNamedChannel(
  channels: ChannelHistoryPort,
  requesterId: string,
  wanted: string | undefined,
): Promise<{ id: string } | { refused: ChannelVerdict }> {
  let visible;
  try {
    visible = await channels.listMemberChannels(requesterId, CHANNEL_LOOKUP_LIMIT);
  } catch (error) {
    logger.error('Knowledge — liste des canaux du demandeur illisible', { requesterId, error });
    return { refused: 'unavailable' };
  }

  const match = resolveChannelName(visible, wanted);

  if (!match) {
    logger.info('Knowledge — nom de canal non résolu parmi ceux du demandeur', {
      requesterId,
      visible: visible.length,
    });
    return { refused: 'channel_not_found' };
  }

  if ('ambiguous' in match) {
    logger.info('Knowledge — nom de canal ambigu', { requesterId, candidates: match.ambiguous });
    return { refused: 'ambiguous_channel' };
  }

  return { id: match.id };
}

import { slackErrorCode } from '../../../../shared/slack/slack-error';
import {
  ChannelUnavailableError,
  type ChannelUnavailableReason,
} from '../../domain/ports/channel-history.port';

export function toUnprovable(error: unknown, channelId: string): ChannelUnavailableError {
  const code = slackErrorCode(error);

  if (code === 'channel_not_found') {
    return new ChannelUnavailableError(
      'channel_not_found',
      `Aucun canal visible sous ${channelId} (${code})`,
      { cause: error },
    );
  }

  const detail = code ? ` (${code})` : '';
  return new ChannelUnavailableError(
    'unavailable',
    `Appartenance non vérifiable sur ${channelId}${detail}`,
    { cause: error },
  );
}

export function toUnavailable(error: unknown, channelId: string): ChannelUnavailableError {
  const code = slackErrorCode(error);

  if (code === 'not_in_channel' || code === 'missing_scope' || code === 'channel_not_found') {
    const reason: ChannelUnavailableReason = 'bot_not_in_channel';
    return new ChannelUnavailableError(
      reason,
      `Slack a refusé la lecture de ${channelId} (${code})`,
      { cause: error },
    );
  }

  return new ChannelUnavailableError('unavailable', `Slack indisponible pour ${channelId}`, {
    cause: error,
  });
}

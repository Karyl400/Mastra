import type { SlackJoinOutcome } from '../../domain/ports/slack-workspace.port';
import { logger } from '../../../../shared/logger';
import { errorMessage } from '../../../../shared/errors';
import { slackErrorMentions } from '../../../../shared/slack/slack-error';

export function mapJoinFailure(err: unknown, channelId: string): SlackJoinOutcome {
  if (slackErrorMentions(err, 'already_in_channel')) {
    return { status: 'already_member' };
  }
  if (slackErrorMentions(err, 'method_not_supported_for_channel_type')) {
    return { status: 'not_public', error: 'method_not_supported_for_channel_type' };
  }
  if (slackErrorMentions(err, 'is_archived')) {
    return { status: 'archived', error: 'is_archived' };
  }
  if (slackErrorMentions(err, 'missing_scope')) {
    return { status: 'missing_scope', error: 'missing_scope' };
  }
  if (slackErrorMentions(err, 'channel_not_found')) {
    return { status: 'not_found', error: 'channel_not_found' };
  }

  const message = errorMessage(err);
  logger.warn('Failed to join Slack channel', { channelId, error: message });
  return { status: 'failed', error: message };
}

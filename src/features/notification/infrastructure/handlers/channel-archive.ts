import { logger } from '../../../../shared/logger';
import {
  archiveIdOf,
  isArchivableChannelType,
  postedAtOf,
} from '../../../knowledge/domain/ports/message-archive.repository';
import type { SlackHandlerInternals } from './handler-internals';
import { isTeamJoinEvent, type SlackEvent, type SlackMessageEvent } from './slack-event.types';

export async function archiveChannelMessage(
  self: SlackHandlerInternals,
  event: SlackEvent,
): Promise<void> {
  const ingestion = self.knowledgeIngestion;
  if (!ingestion || isTeamJoinEvent(event)) {
    return;
  }

  const message = event as SlackMessageEvent;
  if (!isArchivableChannelType(message.channel_type)) {
    return;
  }
  if (message.bot_id || message.subtype === 'bot_message') {
    return;
  }

  const text = (message.text ?? '').trim();
  if (!text || !message.channel || !message.ts) {
    return;
  }

  try {
    await ingestion.ingest({
      id: archiveIdOf(message.channel, message.ts),
      channelId: message.channel,
      slackUserId: message.user ?? null,
      text,
      threadTs: message.thread_ts ?? null,
      postedAt: postedAtOf(message.ts),
    });
  } catch (error) {
    logger.warn('Message non archivé — la connaissance dégrade, le bot répond', {
      channel: message.channel,
      error: String(error),
    });
  }
}

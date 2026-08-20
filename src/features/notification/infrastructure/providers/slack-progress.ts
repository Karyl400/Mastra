import type { WebClient } from '@slack/web-api';
import { logger } from '../../../../shared/logger';

export interface ProgressTarget {
  channel: string;
  threadTs?: string;
}

export interface ProgressHandle {
  resolve(text: string): Promise<void>;
  fail(text: string): Promise<void>;
}

export const PROGRESS_MARKER_TEXT = 'Je regarde ça, un instant…';

type ProgressClient = Pick<WebClient, 'chat'>;

function warnDegraded(message: string, channel: string, error: unknown): void {
  logger.warn(message, { channel, error });
}

export async function startProgress(
  client: ProgressClient,
  target: ProgressTarget,
): Promise<ProgressHandle> {
  const { channel, threadTs } = target;

  const post = (text: string): Promise<{ ts?: string }> =>
    client.chat.postMessage(threadTs ? { channel, text, thread_ts: threadTs } : { channel, text });

  const markerTs: Promise<string | undefined> = post(PROGRESS_MARKER_TEXT)
    .then((response) => {
      const ts = response?.ts;
      if (!ts) {
        warnDegraded('Slack progress marker was posted without a ts', channel, undefined);
        return undefined;
      }
      return ts;
    })
    .catch((error: unknown) => {
      warnDegraded(
        'Unable to post the Slack progress marker — continuing without it',
        channel,
        error,
      );
      return undefined;
    });

  let markerConsumed = false;

  const settle = async (text: string): Promise<void> => {
    const ts = markerConsumed ? undefined : await markerTs;

    if (ts) {
      markerConsumed = true;
      try {
        await client.chat.update({ channel, ts, text });
        return;
      } catch (error: unknown) {
        warnDegraded(
          'Unable to update the Slack progress marker — posting the answer as a new message',
          channel,
          error,
        );
      }
    }

    await post(text);
  };

  return {
    resolve: (text: string) => settle(text),

    fail: async (text: string): Promise<void> => {
      try {
        await settle(text);
      } catch (error: unknown) {
        logger.error('Unable to deliver the Slack failure message', { channel, error });
      }
    },
  };
}

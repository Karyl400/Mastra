import { logger } from '../../../../shared/logger';
import type { DigestDeliveryPort } from '../../domain/ports/digest-delivery.port';

export type DigestOutcome = 'delivered' | 'failed' | 'unavailable';

export async function deliverDigest(
  digests: DigestDeliveryPort | undefined,
  request: {
    channelId: string;
    requesterId: string;
    target: { channel?: string; threadTs?: string };
    title: string;
    coverage: string;
    lines: string;
  },
): Promise<DigestOutcome> {
  if (!digests || !request.target.channel) {
    return 'unavailable';
  }

  try {
    const verdict = await digests.deliver(
      {
        channelId: request.channelId,
        title: request.title,
        coverage: request.coverage,
        lines: request.lines.split('\n').filter((line) => line.trim().length > 0),
      },
      {
        channel: request.target.channel,
        ...(request.target.threadTs ? { threadTs: request.target.threadTs } : {}),
      },
    );

    if (verdict.delivered) {
      logger.info('Knowledge — résumé de canal livré en document', {
        requesterId: request.requesterId,
        channelId: request.channelId,
        filename: verdict.filename,
      });
      return 'delivered';
    }

    logger.error('Knowledge — livraison du résumé en document impossible', {
      requesterId: request.requesterId,
      channelId: request.channelId,
      reason: verdict.reason,
    });
    return 'failed';
  } catch (error) {
    logger.error('Knowledge — livraison du résumé en document en échec', {
      requesterId: request.requesterId,
      channelId: request.channelId,
      error,
    });
    return 'failed';
  }
}

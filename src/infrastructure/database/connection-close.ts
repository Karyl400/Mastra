import type { Client } from '@libsql/client';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { logger } from '../../shared/logger';
import { errorMessage } from '../../shared/errors';

export async function closeClient(
  client: Client | null,
  dbUrl: string,
  connectedAt: Date | null,
): Promise<void> {
  const tracer = trace.getTracer('db-connection');
  const span = tracer.startSpan('db.close');

  try {
    if (client) {
      client.close();
      logger.info('Database connection closed successfully', {
        dbUrl,
        connectionDuration: connectedAt ? Date.now() - connectedAt.getTime() : 0,
      });
    }
  } catch (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: errorMessage(error),
    });
    logger.error('Error closing database connection', { error });
    throw error;
  } finally {
    span.end();
  }
}

import type { Client } from '@libsql/client';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { errorMessage } from '../../shared/errors';

export async function pingDatabase(client: Client | null): Promise<boolean> {
  const tracer = trace.getTracer('db-connection');
  const span = tracer.startSpan('db.health-check');

  try {
    if (!client) {
      span.setAttribute('health.status', 'disconnected');
      return false;
    }

    const result = await client.execute('SELECT 1 as alive');
    const isAlive = result.rows.length > 0 && result.rows[0].alive === 1;

    span.setAttribute('health.status', isAlive ? 'healthy' : 'unhealthy');
    span.setStatus({ code: isAlive ? SpanStatusCode.OK : SpanStatusCode.ERROR });

    return isAlive;
  } catch (error) {
    span.setAttribute('health.status', 'error');
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: errorMessage(error),
    });
    return false;
  } finally {
    span.end();
  }
}

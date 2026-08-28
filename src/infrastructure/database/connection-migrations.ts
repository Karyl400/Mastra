import { migrate } from 'drizzle-orm/libsql/migrator';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { logger } from '../../shared/logger';
import { errorMessage } from '../../shared/errors';
import { DatabaseMigrationError } from './connection-errors';
import type { DatabaseInstance } from './connection-types';

export async function runDatabaseMigrations(
  db: DatabaseInstance,
  migrationsFolder: string,
): Promise<void> {
  const tracer = trace.getTracer('db-connection');
  const span = tracer.startSpan('db.migrate');

  try {
    logger.info('Running database migrations...');

    await migrate(db, {
      migrationsFolder,
    });

    logger.info('Database migrations completed successfully');
    span.setStatus({ code: SpanStatusCode.OK });
  } catch (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: errorMessage(error),
    });

    logger.error('Database migration failed', { error });
    throw new DatabaseMigrationError(
      'Failed to run database migrations',
      error instanceof Error ? error : undefined,
    );
  } finally {
    span.end();
  }
}

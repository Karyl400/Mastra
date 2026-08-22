import { drizzle } from 'drizzle-orm/libsql';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { createClient, type Client } from '@libsql/client';
import * as schema from './schema';
import { logger } from '../../shared/logger';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { trace, SpanStatusCode } from '@opentelemetry/api';

type DatabaseInstance = LibSQLDatabase<typeof schema>;

interface ConnectionConfig {
  dbUrl: string;
  authToken: string;
  autoMigrate: boolean;
  migrationsFolder: string;
}

interface ConnectionManager {
  getDb(): DatabaseInstance;
  close(): Promise<void>;
  healthCheck(): Promise<boolean>;
  getStats(): DatabaseStats;
}

interface DatabaseStats {
  isConnected: boolean;
  dbUrl: string;
  lastConnectedAt: Date | null;
  connectionCount: number;
}

const DEFAULT_CONFIG: ConnectionConfig = {
  dbUrl: process.env.DATABASE_URL || 'file:./data/kisso.db',
  authToken: process.env.DATABASE_AUTH_TOKEN || '',
  autoMigrate: process.env.AUTO_MIGRATE === 'true',
  migrationsFolder: process.env.DB_MIGRATIONS_FOLDER || './drizzle',
};

let dbShutdownHandlersRegistered = false;

class LibSqlConnectionManager implements ConnectionManager {
  private db: DatabaseInstance | null = null;
  private client: Client | null = null;
  private config: ConnectionConfig;
  private connectedAt: Date | null = null;
  private connectionCount: number = 0;
  private isClosing: boolean = false;

  constructor(config: Partial<ConnectionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  getDb(): DatabaseInstance {
    if (this.isClosing) {
      throw new Error('Database connection is closing, cannot accept new requests');
    }

    if (!this.db || !this.client) {
      this.connect();
    }

    return this.db!;
  }

  async close(): Promise<void> {
    const tracer = trace.getTracer('db-connection');
    const span = tracer.startSpan('db.close');

    try {
      this.isClosing = true;

      if (this.client) {
        this.client.close();
        logger.info('Database connection closed successfully', {
          dbUrl: this.config.dbUrl,
          connectionDuration: this.connectedAt ? Date.now() - this.connectedAt.getTime() : 0,
        });
      }
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : 'Unknown error',
      });
      logger.error('Error closing database connection', { error });
      throw error;
    } finally {
      this.client = null;
      this.db = null;
      this.connectedAt = null;
      this.isClosing = false;
      span.end();
    }
  }

  async healthCheck(): Promise<boolean> {
    const tracer = trace.getTracer('db-connection');
    const span = tracer.startSpan('db.health-check');

    try {
      if (!this.client) {
        span.setAttribute('health.status', 'disconnected');
        return false;
      }

      const result = await this.client.execute('SELECT 1 as alive');
      const isAlive = result.rows.length > 0 && result.rows[0].alive === 1;

      span.setAttribute('health.status', isAlive ? 'healthy' : 'unhealthy');
      span.setStatus({ code: isAlive ? SpanStatusCode.OK : SpanStatusCode.ERROR });

      return isAlive;
    } catch (error) {
      span.setAttribute('health.status', 'error');
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    } finally {
      span.end();
    }
  }

  getStats(): DatabaseStats {
    return {
      isConnected: this.client !== null,
      dbUrl: this.config.dbUrl,
      lastConnectedAt: this.connectedAt,
      connectionCount: this.connectionCount,
    };
  }

  private connect(): void {
    const tracer = trace.getTracer('db-connection');
    const span = tracer.startSpan('db.connect');

    try {
      this.client = createClient({
        url: this.config.dbUrl,
        authToken: this.config.authToken,
      });

      this.db = drizzle(this.client, { schema });

      if (this.config.autoMigrate) {
        this.runMigrations().catch((e) => {
          logger.error('Failed to run background migrations', { error: e });
        });
      }

      this.connectedAt = new Date();
      this.connectionCount++;

      this.setupGracefulShutdown();

      logger.info('Database connection established', {
        dbUrl: this.config.dbUrl,
        migrations: this.config.autoMigrate,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      span.setAttribute('db.url', this.config.dbUrl);
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : 'Unknown error',
      });

      logger.error('Failed to connect to database', {
        error,
        dbUrl: this.config.dbUrl,
      });

      throw new DatabaseConnectionError(
        `Failed to connect to database at ${this.config.dbUrl}`,
        error instanceof Error ? error : undefined,
      );
    } finally {
      span.end();
    }
  }

  private async runMigrations(): Promise<void> {
    if (!this.db) return;

    const tracer = trace.getTracer('db-connection');
    const span = tracer.startSpan('db.migrate');

    try {
      logger.info('Running database migrations...');

      await migrate(this.db, {
        migrationsFolder: this.config.migrationsFolder,
      });

      logger.info('Database migrations completed successfully');
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : 'Unknown error',
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

  private setupGracefulShutdown(): void {
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, closing database connection gracefully...`);
      try {
        await this.close();
        logger.info('Database connection closed during shutdown');
      } catch (error) {
        logger.error('Error during database shutdown', { error });
      }
    };

    if (!dbShutdownHandlersRegistered) {
      process.on('SIGTERM', () => {
        void shutdown('SIGTERM');
      });
      process.on('SIGINT', () => {
        void shutdown('SIGINT');
      });
      process.on('SIGQUIT', () => {
        void shutdown('SIGQUIT');
      });
      dbShutdownHandlersRegistered = true;
    }
  }
}

export class DatabaseConnectionError extends Error {
  public readonly code = 'DB_CONNECTION_ERROR';

  constructor(
    message: string,
    public override readonly cause?: Error,
  ) {
    super(message);
    this.name = 'DatabaseConnectionError';
  }
}

export class DatabaseMigrationError extends Error {
  public readonly code = 'DB_MIGRATION_ERROR';

  constructor(
    message: string,
    public override readonly cause?: Error,
  ) {
    super(message);
    this.name = 'DatabaseMigrationError';
  }
}

let connectionManager: ConnectionManager | null = null;

function getConnectionManager(): ConnectionManager {
  if (!connectionManager) {
    connectionManager = new LibSqlConnectionManager({
      dbUrl: process.env.DATABASE_URL || 'file:./data/kisso.db',
      authToken: process.env.DATABASE_AUTH_TOKEN || '',
      autoMigrate: process.env.AUTO_MIGRATE === 'true',
      migrationsFolder: process.env.DB_MIGRATIONS_FOLDER || './drizzle',
    });
  }

  return connectionManager;
}

export function getDb(): DatabaseInstance {
  return getConnectionManager().getDb();
}

export async function closeDb(): Promise<void> {
  if (connectionManager) {
    await connectionManager.close();
    connectionManager = null;
  }
}

export async function healthCheck(): Promise<boolean> {
  if (!connectionManager) {
    return false;
  }
  return connectionManager.healthCheck();
}

export function getDbStats(): DatabaseStats {
  return getConnectionManager().getStats();
}

export async function resetConnection(): Promise<void> {
  await closeDb();
  connectionManager = null;
}

export type { ConnectionConfig, ConnectionManager, DatabaseInstance, DatabaseStats };

export { LibSqlConnectionManager, getConnectionManager };

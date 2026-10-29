import { drizzle } from 'drizzle-orm/libsql';
import { createClient, type Client } from '@libsql/client';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import * as schema from './schema';
import { logger } from '../../shared/logger';
import { errorMessage } from '../../shared/errors';
import { DatabaseConnectionError } from './connection-errors';
import { closeClient } from './connection-close';
import { pingDatabase } from './connection-health';
import { runDatabaseMigrations } from './connection-migrations';
import { registerDbShutdownHandlers } from './connection-shutdown';
import type {
  ConnectionConfig,
  ConnectionManager,
  DatabaseInstance,
  DatabaseStats,
} from './connection-types';

const DEFAULT_CONFIG: ConnectionConfig = {
  dbUrl: process.env.DATABASE_URL || 'file:./data/kisso.db',
  authToken: process.env.DATABASE_AUTH_TOKEN || '',
  autoMigrate: process.env.AUTO_MIGRATE === 'true',
  migrationsFolder: process.env.DB_MIGRATIONS_FOLDER || './drizzle',
};

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
    try {
      this.isClosing = true;
      await closeClient(this.client, this.config.dbUrl, this.connectedAt);
    } finally {
      this.client = null;
      this.db = null;
      this.connectedAt = null;
      this.isClosing = false;
    }
  }

  async healthCheck(): Promise<boolean> {
    return pingDatabase(this.client);
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
        message: errorMessage(error),
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
    if (!this.db) {
      return;
    }

    await runDatabaseMigrations(this.db, this.config.migrationsFolder);
  }

  private setupGracefulShutdown(): void {
    registerDbShutdownHandlers(() => this.close());
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

export { DatabaseConnectionError, DatabaseMigrationError } from './connection-errors';

export type { ConnectionConfig, ConnectionManager, DatabaseInstance, DatabaseStats };

export { LibSqlConnectionManager, getConnectionManager };

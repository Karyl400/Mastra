import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type * as schema from './schema';

export type DatabaseInstance = LibSQLDatabase<typeof schema>;

export interface ConnectionConfig {
  dbUrl: string;
  authToken: string;
  autoMigrate: boolean;
  migrationsFolder: string;
}

export interface ConnectionManager {
  getDb(): DatabaseInstance;
  close(): Promise<void>;
  healthCheck(): Promise<boolean>;
  getStats(): DatabaseStats;
}

export interface DatabaseStats {
  isConnected: boolean;
  dbUrl: string;
  lastConnectedAt: Date | null;
  connectionCount: number;
}

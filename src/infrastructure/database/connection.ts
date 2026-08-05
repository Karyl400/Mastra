// ============================================
// db/connection.ts - Production-Grade DB Connection Manager
// Standards 2026: Serverless-safe, PRAGMAs, Migrations, Graceful Shutdown
// ============================================

import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import * as schema from './schema';
import { logger } from '../../shared/logger';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';

// ============================================
// 1. TYPES
// ============================================

type DatabaseInstance = BetterSQLite3Database<typeof schema>;

interface ConnectionConfig {
  /** Chemin vers le fichier SQLite */
  dbPath: string;
  /** Activer le mode WAL */
  wal: boolean;
  /** Timeout en ms pour les locks (défaut: 5000) */
  busyTimeout: number;
  /** Activer les clés étrangères */
  enableForeignKeys: boolean;
  /** Exécuter les migrations au démarrage */
  autoMigrate: boolean;
  /** Dossier des migrations */
  migrationsFolder: string;
  /** Niveau de log */
  verbose: boolean;
}

interface ConnectionManager {
  getDb(): DatabaseInstance;
  close(): Promise<void>;
  healthCheck(): Promise<boolean>;
  getStats(): DatabaseStats;
}

interface DatabaseStats {
  isConnected: boolean;
  dbPath: string;
  sizeBytes: number;
  walSizeBytes: number;
  tableCount: number;
  totalChanges: number;
  lastConnectedAt: Date | null;
  connectionCount: number;
}

// ============================================
// 2. CONFIGURATION PAR DÉFAUT
// ============================================

const DEFAULT_CONFIG: ConnectionConfig = {
  dbPath: process.env.DATABASE_PATH || './data/kisso.db',
  wal: process.env.DB_WAL !== 'false', // Activé par défaut
  busyTimeout: parseInt(process.env.DB_BUSY_TIMEOUT || '5000', 10),
  enableForeignKeys: true,
  autoMigrate: process.env.AUTO_MIGRATE === 'true',
  migrationsFolder: process.env.DB_MIGRATIONS_FOLDER || './drizzle',
  verbose: process.env.DB_VERBOSE === 'true',
};

// Flag module-scope pour éviter l'enregistrement multiple des handlers OS
let dbShutdownHandlersRegistered = false;

// ============================================
// 3. CONNECTION MANAGER (Serverless-Safe)
// ============================================

class SqliteConnectionManager implements ConnectionManager {
  private db: DatabaseInstance | null = null;
  private sqlite: Database.Database | null = null;
  private config: ConnectionConfig;
  private connectedAt: Date | null = null;
  private connectionCount: number = 0;
  private isClosing: boolean = false;
  private pendingOperations: Set<Promise<unknown>> = new Set();
  
  constructor(config: Partial<ConnectionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
  
  // ============================================
  // PUBLIC API
  // ============================================
  
  /**
   * Récupère l'instance de base de données
   * Thread-safe et serverless-safe
   */
  getDb(): DatabaseInstance {
    // Empêcher les nouvelles connexions pendant la fermeture
    if (this.isClosing) {
      throw new Error('Database connection is closing, cannot accept new requests');
    }
    
    if (!this.db || !this.sqlite) {
      this.connect();
    }
    
    return this.db!;
  }
  
  /**
   * Ferme proprement la connexion
   */
  async close(): Promise<void> {
    const tracer = trace.getTracer('db-connection');
    const span = tracer.startSpan('db.close');
    
    try {
      this.isClosing = true;
      
      // Attendre la fin des opérations en cours
      if (this.pendingOperations.size > 0) {
        logger.info('Waiting for pending database operations to complete', {
          pendingCount: this.pendingOperations.size,
        });
        
        await Promise.race([
          Promise.allSettled([...this.pendingOperations]),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout waiting for pending operations')), 10000)
          ),
        ]);
      }
      
      if (this.sqlite) {
        // Checkpoint WAL avant fermeture (force l'écriture du WAL dans le fichier principal)
        this.sqlite.pragma('wal_checkpoint(TRUNCATE)');
        
        // Fermer la connexion
        this.sqlite.close();
        
        logger.info('Database connection closed successfully', {
          dbPath: this.config.dbPath,
          connectionDuration: this.connectedAt 
            ? Date.now() - this.connectedAt.getTime() 
            : 0,
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
      this.sqlite = null;
      this.db = null;
      this.connectedAt = null;
      this.isClosing = false;
      this.pendingOperations.clear();
      span.end();
    }
  }
  
  /**
   * Vérifie l'état de santé de la connexion
   */
  async healthCheck(): Promise<boolean> {
    const tracer = trace.getTracer('db-connection');
    const span = tracer.startSpan('db.health-check');
    
    try {
      if (!this.sqlite) {
        span.setAttribute('health.status', 'disconnected');
        return false;
      }
      
      // Exécuter une requête simple pour vérifier la connexion
      const result = this.sqlite.prepare('SELECT 1 as alive').get() as { alive: number };
      const isAlive = result?.alive === 1;
      
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
  
  /**
   * Récupère les statistiques de la base de données
   */
  getStats(): DatabaseStats {
    const stats: DatabaseStats = {
      isConnected: this.sqlite !== null,
      dbPath: this.config.dbPath,
      sizeBytes: 0,
      walSizeBytes: 0,
      tableCount: 0,
      totalChanges: 0,
      lastConnectedAt: this.connectedAt,
      connectionCount: this.connectionCount,
    };
    
    if (this.sqlite && existsSync(this.config.dbPath)) {
      try {
        const { size } = require('fs').statSync(this.config.dbPath);
        stats.sizeBytes = size;
        
        const walPath = this.config.dbPath + '-wal';
        if (existsSync(walPath)) {
          stats.walSizeBytes = require('fs').statSync(walPath).size;
        }
        
        const tableCountResult = this.sqlite.prepare(
          "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table'"
        ).get() as { count: number };
        stats.tableCount = tableCountResult?.count || 0;
        
        stats.totalChanges = this.sqlite.prepare(
          'SELECT total_changes() as changes'
        ).get() as unknown as number || 0;
        
      } catch {
        // Ignorer les erreurs de stats
      }
    }
    
    return stats;
  }
  
  // ============================================
  // PRIVATE METHODS
  // ============================================
  
  /**
   * Établit la connexion à la base de données
   */
  private connect(): void {
    const tracer = trace.getTracer('db-connection');
    const span = tracer.startSpan('db.connect');
    
    try {
      // Créer le dossier parent si nécessaire
      const dbDir = dirname(resolve(this.config.dbPath));
      if (!existsSync(dbDir)) {
        mkdirSync(dbDir, { recursive: true });
        logger.info('Created database directory', { directory: dbDir });
      }
      
      // Initialiser la connexion SQLite
      this.sqlite = new Database(this.config.dbPath, {
        // verbose: this.config.verbose ? console.log : undefined,
      });
      
      // Configurer les PRAGMAs essentiels
      this.configurePragmas();
      
      // Créer l'instance Drizzle
      this.db = drizzle(this.sqlite, { schema });
      
      // Exécuter les migrations si configuré
      if (this.config.autoMigrate) {
        this.runMigrations();
      }
      
      this.connectedAt = new Date();
      this.connectionCount++;
      
      // Configurer le graceful shutdown
      this.setupGracefulShutdown();
      
      logger.info('Database connection established', {
        dbPath: this.config.dbPath,
        wal: this.config.wal,
        migrations: this.config.autoMigrate,
      });
      
      span.setStatus({ code: SpanStatusCode.OK });
      span.setAttribute('db.path', this.config.dbPath);
      span.setAttribute('db.wal', this.config.wal);
      
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : 'Unknown error',
      });
      
      logger.error('Failed to connect to database', {
        error,
        dbPath: this.config.dbPath,
      });
      
      throw new DatabaseConnectionError(
        `Failed to connect to database at ${this.config.dbPath}`,
        error instanceof Error ? error : undefined
      );
      
    } finally {
      span.end();
    }
  }
  
  /**
   * Configure les PRAGMAs essentiels
   */
  private configurePragmas(): void {
    if (!this.sqlite) return;
    
    const pragmas: Record<string, string | number> = {
      // === PERFORMANCE ===
      'journal_mode': this.config.wal ? 'WAL' : 'DELETE',
      'synchronous': this.config.wal ? 'NORMAL' : 'FULL', // NORMAL = bon compromis perf/sécurité avec WAL
      'cache_size': -64000, // 64MB cache
      'mmap_size': 268435456, // 256MB memory-mapped I/O
      'temp_store': 'MEMORY', // Stockage temporaire en mémoire
      
      // === CONCURRENCE ===
      'busy_timeout': this.config.busyTimeout,
      
      // === INTÉGRITÉ ===
      'foreign_keys': this.config.enableForeignKeys ? 'ON' : 'OFF',
      'ignore_check_constraints': 'OFF',
      
      // === SÉCURITÉ ===
      'trusted_schema': 'OFF', // Protection contre les attaques par schema SQL
      'recursive_triggers': 'OFF', // Désactiver par défaut (sécurité)
    };
    
    for (const [pragma, value] of Object.entries(pragmas)) {
      try {
        this.sqlite.pragma(`${pragma} = ${value}`);
        
        if (this.config.verbose) {
          logger.debug('PRAGMA set', { pragma, value });
        }
      } catch (error) {
        logger.warn('Failed to set PRAGMA', { pragma, value, error });
      }
    }
  }
  
  /**
   * Exécute les migrations Drizzle
   */
  private runMigrations(): void {
    if (!this.db) return;
    
    const tracer = trace.getTracer('db-connection');
    const span = tracer.startSpan('db.migrate');
    
    try {
      logger.info('Running database migrations...');
      
      migrate(this.db, {
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
        error instanceof Error ? error : undefined
      );
      
    } finally {
      span.end();
    }
  }
  
  /**
   * Configure le graceful shutdown
   */
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
      process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
      process.on('SIGINT', () => { void shutdown('SIGINT'); });
      process.on('SIGQUIT', () => { void shutdown('SIGQUIT'); });
      dbShutdownHandlersRegistered = true;
    }
  }
}

// ============================================
// 4. ERREURS PERSONNALISÉES
// ============================================

export class DatabaseConnectionError extends Error {
  public readonly code = 'DB_CONNECTION_ERROR';
  
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'DatabaseConnectionError';
  }
}

export class DatabaseMigrationError extends Error {
  public readonly code = 'DB_MIGRATION_ERROR';
  
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'DatabaseMigrationError';
  }
}

// ============================================
// 5. INSTANCE SINGLETON (Serverless-Safe)
// ============================================

/**
 * Gestionnaire de connexion global
 * 
 * En environnement serverless (Vercel, AWS Lambda), le module peut être réutilisé
 * entre les invocations. Le singleton persiste dans le cache du module.
 */
let connectionManager: ConnectionManager | null = null;

/**
 * Récupère l'instance du gestionnaire de connexion
 */
function getConnectionManager(): ConnectionManager {
  if (!connectionManager) {
    connectionManager = new SqliteConnectionManager({
      dbPath: process.env.DATABASE_PATH || './data/kisso.db',
      wal: process.env.DB_WAL !== 'false',
      busyTimeout: parseInt(process.env.DB_BUSY_TIMEOUT || '5000', 10),
      autoMigrate: process.env.AUTO_MIGRATE === 'true',
      migrationsFolder: process.env.DB_MIGRATIONS_FOLDER || './drizzle',
      verbose: process.env.DB_VERBOSE === 'true',
    });
  }
  
  return connectionManager;
}

/**
 * Récupère l'instance de base de données
 */
export function getDb(): DatabaseInstance {
  return getConnectionManager().getDb();
}

/**
 * Ferme la connexion à la base de données
 */
export async function closeDb(): Promise<void> {
  if (connectionManager) {
    await connectionManager.close();
    connectionManager = null;
  }
}

/**
 * Vérifie l'état de santé de la base de données
 */
export async function healthCheck(): Promise<boolean> {
  if (!connectionManager) {
    return false;
  }
  return connectionManager.healthCheck();
}

/**
 * Récupère les statistiques de la base de données
 */
export function getDbStats(): DatabaseStats {
  return getConnectionManager().getStats();
}

/**
 * Réinitialise la connexion (utile pour les tests)
 */
export async function resetConnection(): Promise<void> {
  await closeDb();
  connectionManager = null;
}

// ============================================
// 6. TYPES EXPORTÉS
// ============================================

export type {
  ConnectionConfig,
  ConnectionManager,
  DatabaseInstance,
  DatabaseStats,
};

export {
  SqliteConnectionManager,
  getConnectionManager,
};


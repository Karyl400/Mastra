import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import * as schema from './schema';

let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;
let sqlite: Database.Database | null = null;

export function getDb() {
  if (!dbInstance) {
    sqlite = new Database('sqlite.db');
    // Active le mode WAL pour de meilleures performances concurrentielles
    sqlite.pragma('journal_mode = WAL');
    dbInstance = drizzle(sqlite, { schema });
  }
  return dbInstance;
}

export function closeDb() {
  if (sqlite) {
    sqlite.close();
    sqlite = null;
    dbInstance = null;
  }
}

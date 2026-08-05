import { beforeAll, afterAll } from 'vitest';
import { getDb, closeDb } from '../src/infrastructure/database/connection';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import fs from 'fs';

process.env.NODE_ENV = 'test';

beforeAll(() => {
  // Use Drizzle's programmatic migrator instead of CLI to avoid segfaults
  const db = getDb();
  migrate(db, { migrationsFolder: './drizzle' });
});

afterAll(() => {
  closeDb();
  if (fs.existsSync('test.db')) {
    fs.unlinkSync('test.db');
  }
});

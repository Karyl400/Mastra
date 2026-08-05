import { beforeAll, afterAll } from 'vitest';
import { getDb, closeDb } from '../src/infrastructure/database/connection';
import { migrate } from 'drizzle-orm/libsql/migrator';
import fs from 'fs';

process.env.NODE_ENV = 'test';

beforeAll(async () => {
  // Use Drizzle's programmatic migrator instead of CLI to avoid segfaults
  const db = getDb();
  await migrate(db, { migrationsFolder: './drizzle' });
});

afterAll(() => {
  closeDb();
  if (fs.existsSync('test.db')) {
    fs.unlinkSync('test.db');
  }
});

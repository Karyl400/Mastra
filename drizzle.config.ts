import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/infrastructure/database/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'file:./data/kisso.db',
    token: process.env.DATABASE_AUTH_TOKEN,
  },
});

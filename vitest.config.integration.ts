import { defineConfig } from 'vitest/config';

// Config AUTORITAIRE des tests d'intégration — référencée par
// `npm run test:integration` (package.json). C'est la seule : l'ancien
// `vitest.integration.config.ts` (orphelin, jamais référencé) a été supprimé.
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    fileParallelism: false,
    pool: 'forks',
    // global-setup.ts : crée une base SQLite jetable conforme au schéma Drizzle.
    // setup.ts : charge .env dans process.env (Vitest ne le fait pas) et pointe
    // la connexion sur cette base jetable plutôt que sur Turso / data/kisso.db.
    globalSetup: ['./tests/integration/global-setup.ts'],
    setupFiles: ['./tests/integration/setup.ts'],
    include: ['tests/integration/**/*.test.ts', 'tests/unit/infrastructure/**/*.test.ts'],
    server: {
      deps: {
        inline: [/@mastra\/core/],
      },
    },
  },
});

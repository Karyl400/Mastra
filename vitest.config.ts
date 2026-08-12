import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    fileParallelism: false,
    pool: 'forks',
    // Vitest 4 a REMONTÉ ces options au niveau racine : `poolOptions.forks.singleFork` y était
    // silencieusement ignoré, donc l'isolation que ce fichier prétendait imposer n'existait pas.
    singleFork: true,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/tests/integration/**',
      '**/tests/unit/infrastructure/**',
    ],
    server: {
      deps: {
        inline: [/@mastra\/core/],
      },
    },
  },
});

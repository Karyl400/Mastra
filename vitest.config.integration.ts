import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    include: ['tests/integration/**/*.test.ts', 'tests/unit/infrastructure/**/*.test.ts'],
    server: {
      deps: {
        inline: [/@mastra\/core/],
      },
    },
  },
});

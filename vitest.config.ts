import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    fileParallelism: false,
    pool: 'forks',
    server: {
      deps: {
        inline: [/@mastra\/core/]
      }
    }
  },
});

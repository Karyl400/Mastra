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
    // ────────────────────────────────────────────────────────────────────────
    // COUVERTURE — mesurée, et bornée là où ça compte
    // ────────────────────────────────────────────────────────────────────────
    // Il n'y en avait AUCUNE : 1 568 tests verts, et rien pour dire ce qui n'était PAS
    // couvert. Un seuil GLOBAL a été écarté délibérément — sur un dépôt de cette taille il
    // produirait un échec permanent que tout le monde apprendrait à ignorer, soit exactement
    // ce que faisait `npm run lint` avec son `|| true`.
    //
    // Le seuil ne porte donc que sur `src/shared/security/**` : le garde-fou anti-injection,
    // la rédaction de sortie, la signature Slack et les gardes d'API. C'est le code dont une
    // régression n'est pas visible à l'usage — ailleurs, un défaut se voit dans Slack.
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/mastra/index.ts'],
      thresholds: {
        'src/shared/security/**': {
          statements: 85,
          branches: 80,
          functions: 85,
          lines: 85,
        },
      },
    },
  },
});

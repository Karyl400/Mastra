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
    /**
     * ⚠️ **`include` EST POSÉ, et ce n'est pas une précaution de style.**
     *
     * Sans lui, Vitest part de son motif par défaut depuis la RACINE du projet, et
     * ramasse tout ce qui traîne dans l'arborescence. L'audit du 2026-08-21 a trouvé
     * `agent-marcel/` — une COPIE COMPLÈTE du projet figée au 2026-08-20, gitignorée — dont
     * **152 fichiers de test** s'exécutaient à chaque `npm run test:unit` :
     *
     *   affiché : 315 fichiers / 4 612 tests / 138 s
     *   réel    : 163 fichiers / 2 426 tests /  85 s
     *
     * Le chiffre gonflé n'était pas le pire. `agent-marcel/` étant gitignoré, il n'existe pas
     * sur le runner : **la même commande mesurait deux choses différentes selon l'endroit**, et
     * c'est le local qui mentait pendant que la CI restait verte. Le jour où la copie figée
     * serait devenue rouge, un développeur aurait vu une suite rouge désignant des fichiers
     * absents de son dépôt.
     *
     * Un `include` ANCRÉ ferme la classe entière : aucun répertoire futur, quel que soit son
     * nom, ne pourra plus entrer par la porte du défaut. Une ligne d'`exclude` de plus n'aurait
     * fermé que ce cas-ci.
     */
    include: ['tests/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
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
      /**
       * ⚠️ **`src/**` n'est PAS ancré** — le glob matche aussi `agent-marcel/src/**`. La
       * couverture affichée agrégeait donc 5 468 statements de la copie figée sur 11 780, soit
       * **46 % du chiffre**. Réel : 85,63 % au lieu des 86,76 % annoncés. Le préfixe `./`
       * ancre à la racine du projet.
       */
      include: ['./src/**/*.ts'],
      exclude: ['**/agent-marcel/**', 'src/**/*.d.ts', 'src/mastra/index.ts'],
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

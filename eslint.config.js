import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig } from 'eslint/config';
import security from 'eslint-plugin-security';
import sonarjs from 'eslint-plugin-sonarjs';

export default defineConfig([
  {
    ignores: [
      'tests/**',
      'dist/**',
      '.mastra/**',
      'drizzle/**',
      'venv/**',
      'node_modules/**',
      '.history/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    plugins: { security, sonarjs, js },
    rules: {
      // Trois `catch` de ce dépôt sont délibérément vides : OpenTelemetry non configuré,
      // écriture de contexte sur un porteur qui ne la supporte pas, et confort d'affichage.
      // Ce sont des fail-open assumés, recensés dans docs/conception/shared.md.
      'no-empty': ['error', { allowEmptyCatch: true }],
      ...security.configs.recommended.rules,
      ...sonarjs.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      // ⚠️ Le préfixe `_` est une CONVENTION ACTIVE de ce dépôt, pas une négligence :
      // `execute: async (data, _ctx)` déclare que le tool reçoit bien un contexte et
      // choisit de ne pas le lire. Supprimer le paramètre changerait l'arité et ferait
      // perdre cette information ; le renommer sans préfixe ferait mentir la convention.
      // Sans ces motifs, la règle signalait 6 paramètres délibérés et noyait les 6 vrais
      // symboles morts au milieu.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      'sonarjs/unused-import': 'warn',
      'sonarjs/cognitive-complexity': 'warn',
      'sonarjs/pseudo-random': 'warn',
      'sonarjs/no-duplicated-branches': 'warn',
      'sonarjs/no-redundant-boolean': 'warn',
      'sonarjs/super-linear-regex': 'warn',
      'sonarjs/regex-complexity': 'warn',
      'sonarjs/no-default-utility-imports': 'warn',
      'sonarjs/prefer-single-boolean-return': 'warn',
      'sonarjs/no-nested-conditional': 'warn',
      'sonarjs/no-unused-vars': 'warn',
      'sonarjs/no-dead-store': 'warn',
      'no-control-regex': 'warn',
      // ⚠️ DÉSACTIVÉE le 2026-08-14, après mesure : 7 des 9 « erreurs » d'ESLint étaient des
      // faux positifs de cette règle. Elle cherche des marqueurs `// TODO:` abandonnés dans le
      // code — intention légitime — mais elle matche le mot n'importe où dans un commentaire,
      // donc elle se déclenchait sur les RENVOIS à `TODO.md`, qui est le registre de dettes du
      // projet et que la culture de commentaires de ce dépôt cite constamment.
      //
      // Le coût n'était pas cosmétique : `npm run lint` se termine par `|| true`, donc ces 9
      // erreurs étaient MUETTES, et `TODO.md` affirmait encore « 0 erreur, 104 warnings ». Une
      // règle qui ne produit que du bruit finit par masquer le signal qu'elle devait porter —
      // c'est ce qui est arrivé ici.
      'sonarjs/todo-tag': 'off',

      // ⚠️ DÉSACTIVÉE le 2026-08-17, APRÈS avoir instruit les 21 signalements un par un —
      // pas pour faire taire un chiffre. Résultat de l'instruction :
      //
      //  • 19 sont des LECTURES dans une table constante (`MIME_TYPES[format]`,
      //    `TASK_STATUS_TRANSITIONS[from]`, `LOG_LEVELS[level]`) ou des index de tableau
      //    (`turns[start].role`, `words[i]`). Il n'y a pas de sink : rien n'est écrit.
      //    La règle ne distingue pas la lecture de l'écriture — elle se déclenche sur TOUT
      //    accès membre calculé, ce que ce dépôt fait partout où il y a une enum.
      //  • 2 étaient réels, et ils ont été CORRIGÉS plutôt que masqués : `agentHasTool`
      //    levait une TypeError sur cinq noms hérités d'`Object.prototype` (voir
      //    `agent-capabilities.ts`), et le journal tirait au sort les clés conservées.
      //
      // Une règle dont 90 % des signalements sont du bruit finit par masquer le signal
      // qu'elle devait porter — c'est exactement ce qui est arrivé ici et à `todo-tag` : les
      // deux vrais défauts étaient noyés au milieu de 19 faux positifs et personne ne les
      // avait vus. Les 21 lignes de `eslint-disable` qu'il aurait fallu semer auraient
      // produit le même aveuglement, en moins lisible.
      //
      // ⚠️ Ce qui remplace la règle n'est PAS rien : la pollution de prototype par clé non
      // maîtrisée est désormais couverte par un test — voir le bloc « nom hérité » de
      // `tests/unit/agents/agent-capabilities.test.ts`. Avant d'écrire une valeur dans un
      // objet sous une clé venue de l'extérieur, se poser la question à la main.
      'security/detect-object-injection': 'off',
    },
    settings: {
      ...sonarjs.configs.recommended.settings,
    },
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  // `scripts/` — 8 146 lignes qui écrivent EN PRODUCTION, et qui étaient nues
  // ══════════════════════════════════════════════════════════════════════════
  //
  // Ce répertoire était dans les `ignores` ci-dessus, et le hook `lint-staged` ne le
  // rattrapait pas : son glob `*.ts` NE MATCHE PAS `.mts`, extension de presque tout
  // `scripts/`. Ni eslint, ni prettier, ni le pre-commit, ni `tsc` ne le lisaient.
  //
  // ⚠️ **Ce n'est pas une question d'hygiène.** Douze de ces quarante fichiers ouvrent une
  // connexion Turso ou un `WebClient` Slack : `set-role.mts` écrit la colonne dont dépend
  // toute la frontière d'autorisation, `probe-erasure.mts` SUPPRIME réellement,
  // `apply-ddl.mts` applique du DDL sur la production. Une faute de frappe y est
  // indétectable avant l'exécution — et l'exécution, c'est la production. Ce dépôt a déjà
  // laissé la base de production sale deux fois de suite par un défaut de script.
  //
  // ⚠️ **Le typecheck a trouvé TROIS défauts réels dans la minute qui a suivi son
  // ouverture** : un appel avec un argument mort (le pré-remplissage disparu avec les
  // modales, dont le commentaire affirmait le contraire), une doublure de dépôt rendant
  // `void` là où le contrat rend un compte, et cette même doublure avec TROIS méthodes de
  // retard sur son port — `x is not a function` à l'exécution.
  //
  // Trois règles sont écartées ICI et nulle part ailleurs, chacune pour une raison propre
  // aux scripts :
  {
    files: ['scripts/**/*.{js,mjs,cjs,ts,mts,cts}'],
    rules: {
      // Un script CONSTRUIT ses chemins — c'est son métier (`apply-ddl.mts` lit le fichier
      // qu'on lui nomme). La règle vise les serveurs qui reçoivent un chemin d'un
      // utilisateur distant ; ici l'« attaquant » est celui qui tape la commande.
      'security/detect-non-literal-fs-filename': 'off',
      // Un script est une PROCÉDURE linéaire, pas un module réutilisable. Le seuil de 15 y
      // dénonce des `main()` parfaitement lisibles, et le découper les rendrait moins
      // faciles à suivre au moment où l'on en a le plus besoin : pendant un incident.
      'sonarjs/cognitive-complexity': 'off',
      // 23 signalements, tous dans des `console.log` de rapport. Aucun n'est un défaut de
      // correction. Les corriger aurait été 23 modifications sans valeur dans des fichiers
      // qu'on ne relit qu'en cas de problème.
      'sonarjs/no-nested-template-literals': 'off',
    },
  },
]);

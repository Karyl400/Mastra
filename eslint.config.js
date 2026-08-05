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
      'scripts/**',
      'node_modules/**',
      '.history/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    plugins: { security, sonarjs, js },
    rules: {
      ...security.configs.recommended.rules,
      ...sonarjs.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-unused-vars': 'warn',
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
    },
    settings: {
      ...sonarjs.configs.recommended.settings,
    },
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
    },
  },
]);

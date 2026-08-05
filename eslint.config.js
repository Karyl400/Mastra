import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";
import security from "eslint-plugin-security";
import sonarjs from "eslint-plugin-sonarjs";

export default defineConfig([
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    plugins: { security, sonarjs, js },
    rules: {
      ...security.configs.recommended.rules,
      ...sonarjs.configs.recommended.rules,
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

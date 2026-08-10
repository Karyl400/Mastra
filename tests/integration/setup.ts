// ============================================
// tests/integration/setup.ts
// Setup exécuté par vitest.config.integration.ts (setupFiles), une fois par
// fichier de test. Deux responsabilités :
//   1. Charger .env dans process.env — Vitest ne le fait PAS tout seul.
//      Sans ça, les tests d'intégration tournent sans AUCUN identifiant
//      (SLACK_BOT_TOKEN, GROQ_API_KEY, DATABASE_URL… tous undefined).
//   2. Rediriger la DB vers la base jetable créée par global-setup.ts.
//      Le DATABASE_URL de .env pointe sur Turso (production) : les tests
//      d'intégration ne doivent NI écrire dedans NI en dépendre.
// ============================================

import dotenv from 'dotenv';
import path from 'node:path';

// 1. Charger .env (ne surcharge pas les variables déjà définies par le shell)
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// 2. Base de test isolée. Surchargeable via INTEGRATION_DATABASE_URL.
process.env.DATABASE_URL =
  process.env.INTEGRATION_DATABASE_URL ?? 'file:./data/integration-test.db';
delete process.env.DATABASE_AUTH_TOKEN;

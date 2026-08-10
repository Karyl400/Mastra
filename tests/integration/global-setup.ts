// ============================================
// tests/integration/global-setup.ts
// Exécuté UNE fois avant toute la suite d'intégration.
// Construit une base SQLite jetable, isolée de la base de dev
// (data/kisso.db) et de Turso.
//
// ⚠️ POURQUOI PAS LE MIGRATEUR DRIZZLE ?
// Les migrations de `drizzle/` sont DÉSYNCHRONISÉES de
// `src/infrastructure/database/schema.ts` : `0000_petite_fantastic_four.sql`
// crée `employees` sans `phone`, `onboarding_status`, `emergency_contact_*`,
// `salary_*`, `metadata`, `deleted_at`. Appliquer ces migrations donne une base
// que l'ORM ne sait pas requêter ("table employees has no column named phone").
// On génère donc le DDL directement depuis le schéma via `drizzle-kit export`,
// ce qui reflète la vérité de l'ORM.
// La dette (`npm run db:generate`, interactif) reste à traiter séparément.
// ============================================

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';

const DB_FILE = path.resolve(process.cwd(), 'data/integration-test.db');

export async function setup(): Promise<void> {
  // Base jetable : on repart de zéro à chaque run.
  for (const suffix of ['', '-shm', '-wal']) {
    const f = `${DB_FILE}${suffix}`;
    if (fs.existsSync(f)) fs.rmSync(f);
  }
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

  const ddl = execFileSync(
    'npx',
    [
      'drizzle-kit',
      'export',
      '--dialect=sqlite',
      '--schema=./src/infrastructure/database/schema.ts',
    ],
    { encoding: 'utf8', cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 },
  );

  const client = createClient({ url: `file:${DB_FILE}` });
  try {
    await client.executeMultiple(ddl);
  } finally {
    client.close();
  }
}

export function teardown(): void {
  // Fichier laissé en place volontairement : utile pour inspecter un échec.
  // Il est recréé de zéro au run suivant.
}

/**
 * Applique un ou plusieurs fichiers DDL sur la base LibSQL/Turso, puis vérifie le résultat.
 *
 * ## Pourquoi ce script existe
 *
 * `drizzle-kit push` SE BLOQUE contre une base `libsql://` distante (dialect `sqlite`) : pas
 * d'erreur, il ne rend jamais la main. Et les migrations `drizzle/` sont désynchronisées de
 * `schema.ts` (`0000_*.sql` crée `employees` avec 11 colonnes, le schéma en déclare ~26), donc
 * les rejouer sur une base vierge échoue. Chaque table ajoutée depuis
 * (`conversation_turns`, `documents.content`, `slack_event_dedup`, `slack_directory`,
 * `rate_limit_counters`) a donc été appliquée à la main, une fois de plus à chaque fois.
 *
 * Ce script est cette opération, rendue reproductible et vérifiable.
 *
 * ## Usage
 *
 *   npx tsx --env-file=.env scripts/apply-ddl.mts scripts/ddl-slack-directory.sql
 *   npx tsx --env-file=.env scripts/apply-ddl.mts scripts/ddl-*.sql
 *
 * ## Ce qu'il garantit, et ce qu'il ne garantit pas
 *
 * Il n'est PAS transactionnel : SQLite exécute chaque DDL isolément, et un `CREATE TABLE` déjà
 * passé ne se défait pas parce que l'index suivant a échoué. C'est acceptable UNIQUEMENT parce
 * que nos fichiers sont rejouables (`IF NOT EXISTS` partout). Un fichier qui ne l'est pas —
 * `ALTER TABLE … ADD COLUMN` n'a pas de forme idempotente en SQLite — doit être relu avant
 * d'être rejoué.
 *
 * Une erreur n'INTERROMPT PAS la boucle : sur un fichier rejouable, `duplicate column name` ou
 * `table already exists` signifient « c'est déjà fait ». Elles sont affichées telles quelles —
 * le silence serait pire, c'est précisément le mode d'échec que ce dépôt paie depuis
 * `emailSent: false`.
 */
import { createClient } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const files = process.argv.slice(2);

if (files.length === 0) {
  console.error('Usage: npx tsx --env-file=.env scripts/apply-ddl.mts <fichier.sql> [...]');
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL manquant. Lancer avec --env-file=.env');
  process.exit(1);
}

const client = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN });

console.log(`Base : ${url.replace(/\/\/.*@/, '//***@')}\n`);

/** Tables touchées, pour la vérification finale. Déduites du DDL, jamais saisies à la main. */
const touched = new Set<string>();
let failures = 0;

for (const file of files) {
  const raw = readFileSync(file, 'utf8');

  // Les commentaires `--` sont retirés AVANT le découpage : les en-têtes de nos fichiers DDL
  // contiennent des `;` en prose (exemples de requêtes de vérification), qui produiraient
  // sinon des énoncés fantômes.
  const statements = raw
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  console.log(`── ${basename(file)} — ${statements.length} énoncé(s)`);

  for (const statement of statements) {
    const match = /(?:TABLE|INDEX)\s+(?:IF NOT EXISTS\s+)?["']?(\w+)/i.exec(statement);
    const onTable = /ON\s+["']?(\w+)/i.exec(statement);
    if (match) touched.add((onTable ?? match)[1]);

    const label = statement.replace(/\s+/g, ' ').slice(0, 64);
    try {
      await client.execute(statement);
      console.log(`   OK    ${label}…`);
    } catch (error) {
      failures += 1;
      console.log(`   ERR   ${label}… → ${(error as Error).message}`);
    }
  }
  console.log();
}

console.log('── Vérification');
for (const table of [...touched].sort()) {
  // On filtre sur `tbl_name` et NON sur `name` : les index ne portent pas le préfixe de leur
  // table, un `name LIKE 'slack_directory%'` les manquerait tous.
  const result = await client.execute({
    sql: 'SELECT type, name FROM sqlite_master WHERE tbl_name = ? ORDER BY type DESC, name',
    args: [table],
  });
  const objects = result.rows.map((row) => `${row.type}:${row.name}`).join(', ');
  console.log(`   ${table}: ${objects || '⚠️  ABSENTE'}`);
}

process.exit(failures > 0 ? 1 : 0);

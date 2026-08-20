/**
 * Applique un fichier DDL sur la base pointée par `DATABASE_URL`.
 *
 * ⚠️ Ce script existe parce que `drizzle-kit push` SE BLOQUE contre une base `libsql://`
 * distante, et parce que `schema.ts` ne sait pas exprimer une table virtuelle FTS5 ni un
 * trigger : `npm run db:init` crée donc les tables mais PAS leur index plein texte.
 *
 * ⚠️ Le découpage respecte `BEGIN … END` : un `;` interne à un trigger ne termine pas
 * l'instruction. Un découpage naïf sur `;` a déjà cassé les triggers de `channel_messages`.
 *
 * Usage : npx tsx --env-file=.env scripts/apply-ddl.mts scripts/ddl-knowledge-facts.sql
 */
import { createClient } from '@libsql/client';
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: apply-ddl.mts <fichier.sql>');
  process.exit(1);
}

function split(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let depth = 0;

  for (const line of sql.split('\n')) {
    const bare = line.replace(/--.*$/, '');
    if (/\bBEGIN\b/i.test(bare)) depth += 1;
    if (/\bEND\s*;/i.test(bare)) depth -= 1;
    current += `${line}\n`;
    if (depth === 0 && /;\s*$/.test(bare)) {
      if (current.replace(/--.*$/gm, '').trim()) statements.push(current.trim());
      current = '';
    }
  }

  if (current.replace(/--.*$/gm, '').trim()) statements.push(current.trim());
  return statements;
}

const client = createClient({
  url: process.env.DATABASE_URL ?? 'file:./data/kisso.db',
  authToken: process.env.DATABASE_AUTH_TOKEN,
});

let failed = 0;

for (const statement of split(readFileSync(file, 'utf8'))) {
  const head = statement.replace(/--.*$/gm, '').trim().split('\n')[0]!.slice(0, 70);
  try {
    await client.execute(statement);
    console.log('OK   ', head);
  } catch (error) {
    // `ALTER TABLE … ADD COLUMN` et consorts n'ont pas de forme `IF NOT EXISTS` : rejouer
    // un DDL déjà appliqué peut donc échouer de façon BÉNIGNE. On le dit, on ne le masque pas.
    failed += 1;
    console.log('ERR  ', head, '→', String(error).slice(0, 160));
  }
}

console.log(failed === 0 ? 'Tout est appliqué.' : `${failed} instruction(s) en erreur.`);

import Database from 'better-sqlite3';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const dbPath = resolve(root, 'data', 'kisso.db');
mkdirSync(dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF'); // OFF pendant migrations pour éviter les FK circulaires

const existingTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables existantes:', existingTables.map(t => t.name).join(', ') || '(aucune)');

const migrations = [
  resolve(root, 'drizzle', '0000_petite_fantastic_four.sql'),
  resolve(root, 'drizzle', '0001_bright_domino.sql'),
];

let applied = 0;
for (const file of migrations) {
  if (!existsSync(file)) {
    console.log('Fichier absent, skip:', file);
    continue;
  }
  const sql = readFileSync(file, 'utf8');
  const statements = sql.split('--> statement-breakpoint').filter(s => s.trim());
  for (const stmt of statements) {
    const clean = stmt.trim();
    if (!clean) continue;
    try {
      db.exec(clean);
      applied++;
    } catch (e) {
      console.warn('Skip:', e.message.substring(0, 80));
    }
  }
  console.log('Migration appliquée:', file.split('/').pop());
}

db.pragma('foreign_keys = ON');
db.close();

const tables = new Database(dbPath).prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log(`\nRésultat : ${applied} statements, ${tables.length} tables créées`);
console.log('Tables:', tables.map(t => t.name).join(', '));
console.log('DB prête :', dbPath);

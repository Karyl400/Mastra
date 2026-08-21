import { readFileSync } from 'node:fs';
import { createClient } from '@libsql/client';
const db = createClient({ url: process.env.DATABASE_URL!, authToken: process.env.DATABASE_AUTH_TOKEN });

const backup = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const dir = backup.directory[0];
const SONDE = '53ffb240-d45b-4de3-b3c7-ddc088d1200a';

for (const table of ['onboarding_interview', 'onboarding_progress', 'notifications', 'documents']) {
  const col = table === 'notifications' ? 'recipient_id' : 'employee_id';
  try {
    const r = await db.execute({ sql: `DELETE FROM ${table} WHERE ${col} = ?`, args: [SONDE] });
    console.log(`${table} : ${r.rowsAffected} ligne(s)`);
  } catch (e) { console.log(`${table} : ${String(e).slice(0, 80)}`); }
}
const e = await db.execute({ sql: 'DELETE FROM employees WHERE id = ?', args: [SONDE] });
console.log('employees sonde :', e.rowsAffected);

await db.execute({
  sql: 'UPDATE slack_directory SET first_name = ?, last_name = ?, email = ?, employee_id = ? WHERE slack_user_id = ?',
  args: [dir.first_name, dir.last_name, dir.email, dir.employee_id, dir.slack_user_id],
});
await db.execute({ sql: 'UPDATE employees SET deleted_at = NULL WHERE id = ?', args: [dir.employee_id] });

const after = await db.execute({
  sql: `SELECT d.slack_user_id, d.first_name, d.last_name, d.email, d.employee_id, e.deleted_at
        FROM slack_directory d LEFT JOIN employees e ON e.id = d.employee_id WHERE d.slack_user_id = ?`,
  args: [dir.slack_user_id],
});
console.log('ÉTAT RELU :', JSON.stringify(after.rows[0]));
const left = await db.execute({ sql: 'SELECT count(*) c FROM employees WHERE id = ?', args: [SONDE] });
console.log('reste-t-il le dossier de sonde ?', left.rows[0]!.c);

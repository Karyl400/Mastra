import { createClient } from '@libsql/client';
const db = createClient({ url: process.env.DATABASE_URL!, authToken: process.env.DATABASE_AUTH_TOKEN });
const d = await db.execute({ sql: 'SELECT slack_user_id, first_name, last_name, email, employee_id FROM slack_directory WHERE slack_user_id = ?', args: ['U0BRRDEMSPN'] });
console.log('annuaire :', JSON.stringify(d.rows[0]));
const e = await db.execute('SELECT id, first_name, last_name, email, deleted_at FROM employees');
console.log('employees :', JSON.stringify(e.rows, null, 1));
const n = await db.execute({ sql: 'SELECT id, subject, status FROM notifications WHERE recipient_id = ?', args: ['53ffb240-d45b-4de3-b3c7-ddc088d1200a'] });
console.log('notifications de la sonde :', JSON.stringify(n.rows));

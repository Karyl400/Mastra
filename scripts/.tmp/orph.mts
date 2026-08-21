import { createClient } from '@libsql/client';
const db = createClient({ url: process.env.DATABASE_URL!, authToken: process.env.DATABASE_AUTH_TOKEN });
const n = await db.execute("SELECT id, recipient_id, subject FROM notifications WHERE subject LIKE '%Amina%'");
console.log('notifications Amina :', JSON.stringify(n.rows));
const o = await db.execute("SELECT employee_id FROM onboarding_progress");
console.log('progress :', JSON.stringify(o.rows));
const i = await db.execute("SELECT employee_id FROM onboarding_interview");
console.log('interviews :', JSON.stringify(i.rows));

import { createClient } from '@libsql/client';
const db = createClient({ url: process.env.DATABASE_URL!, authToken: process.env.DATABASE_AUTH_TOKEN });
const r = await db.execute("SELECT id, status, subject, scheduled_at, created_at FROM notifications WHERE status IN ('scheduled','pending','sending') ORDER BY scheduled_at");
console.table(r.rows.map(x => ({ id: String(x.id).slice(0,8), status: x.status, subject: String(x.subject).slice(0,38), scheduled: x.scheduled_at })));

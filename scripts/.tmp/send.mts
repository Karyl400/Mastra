import { createHmac } from 'node:crypto';
const secret = process.env.SLACK_SIGNING_SECRET!;
const text = process.argv.slice(2).join(' ');
const nowSeconds = Math.floor(Date.now() / 1000);
const body = JSON.stringify({
  type: 'event_callback', team_id: 'TMLKC4EPP', event_id: `EvPROBE${Date.now()}`,
  event_time: nowSeconds,
  event: { type: 'message', channel: 'D0BM9MK9QJV', channel_type: 'im', user: 'U0BJBDGTJUD', text, ts: (Date.now() / 1000).toFixed(6) },
});
const ts = String(nowSeconds);
const sig = 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex');
for (let i = 0; i < 6; i++) {
  try {
    const r = await fetch('https://mastra-71ya.vercel.app/slack/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Slack-Request-Timestamp': ts, 'X-Slack-Signature': sig }, body,
    });
    console.log(`→ « ${text} » ACK ${r.status}`); process.exit(0);
  } catch { await new Promise((r) => setTimeout(r, 3000)); }
}
console.log('réseau indisponible'); process.exit(1);

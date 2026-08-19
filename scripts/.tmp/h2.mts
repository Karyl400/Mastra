const token = process.env.SLACK_BOT_TOKEN!;
const n = Number(process.argv[2] ?? 6);
for (let i=0;i<6;i++){
 try {
  const r = await fetch(`https://slack.com/api/conversations.history?channel=D0BM9MK9QJV&limit=${n}`, { headers: { Authorization: `Bearer ${token}` } });
  const j: any = await r.json();
  for (const m of (j.messages ?? []).reverse()) {
    const d = new Date(Number(m.ts) * 1000).toISOString().slice(11, 19);
    console.log(`[${d}] ${m.bot_id ? 'BOT' : 'HUM'} ${(m.text ?? '').replace(/\n/g, ' ⏎ ').slice(0, 320)}`);
  }
  process.exit(0);
 } catch { await new Promise(r=>setTimeout(r,3000)); }
}

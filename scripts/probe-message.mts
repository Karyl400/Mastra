/**
 * SONDE DE PRODUCTION — envoie UN message et affiche la réponse réellement postée.
 *
 * ⚠️ **Celle-ci COÛTE un vrai appel de modèle**, contrairement à
 * `probe-deterministic-replies.mts` et `probe-stale-event.mts`. Le budget Groq est de
 * ≈ 19 messages par JOUR pour tout le workspace, et le plafond par personne est de 12 :
 * chaque exécution en consomme une. À n'utiliser que pour un scénario qu'aucun test unitaire
 * ne peut couvrir — c'est-à-dire quand ce qu'on veut observer est le COMPORTEMENT DU MODÈLE.
 *
 * Usage :
 *   npx tsx --env-file=.env scripts/probe-message.mts "tu peux me préparer un quiz ?"
 *   npx tsx --env-file=.env scripts/probe-message.mts --wait 45 "..."
 */
import { createHmac } from 'node:crypto';

const DEFAULT_BASE_URL = 'https://mastra-71ya.vercel.app';
const DEFAULT_CHANNEL = 'D0BM9MK9QJV';
const REQUESTER = 'U0BJBDGTJUD';

const args = process.argv.slice(2);
const at = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const baseUrl = at('--url') ?? DEFAULT_BASE_URL;
const channel = at('--channel') ?? DEFAULT_CHANNEL;
const waitSeconds = Number(at('--wait') ?? 40);
const text = args.filter((a, i) => !a.startsWith('--') && args[i - 1]?.startsWith('--') !== true)
  .join(' ')
  .trim();

if (!text) throw new Error('Aucun message à envoyer.');

const signingSecret = process.env.SLACK_SIGNING_SECRET;
const botToken = process.env.SLACK_BOT_TOKEN;
if (!signingSecret) throw new Error('SLACK_SIGNING_SECRET manquant');
if (!botToken) throw new Error('SLACK_BOT_TOKEN manquant');

const nowSeconds = Math.floor(Date.now() / 1000);
const body = JSON.stringify({
  type: 'event_callback',
  team_id: 'TMLKC4EPP',
  event_id: `EvPROBE${Date.now()}`,
  event_time: nowSeconds,
  event: {
    type: 'message',
    channel,
    channel_type: 'im',
    user: REQUESTER,
    text,
    ts: (Date.now() / 1000).toFixed(6),
  },
});

const timestamp = String(nowSeconds);
const signature =
  'v0=' + createHmac('sha256', signingSecret).update(`v0:${timestamp}:${body}`).digest('hex');

const since = nowSeconds - 1;
const started = Date.now();

const response = await fetch(`${baseUrl}/slack/events`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Slack-Request-Timestamp': timestamp,
    'X-Slack-Signature': signature,
  },
  body,
});

console.log(`→ « ${text} »`);
console.log(`  ACK ${response.status} en ${Date.now() - started} ms`);
console.log(`  (attente de ${waitSeconds} s — un run prend 2 à 21 s, jusqu'à ~60 s à froid)\n`);

await new Promise((r) => setTimeout(r, waitSeconds * 1000));

const url = `https://slack.com/api/conversations.history?channel=${channel}&oldest=${since}&limit=20`;
const history = await fetch(url, { headers: { Authorization: `Bearer ${botToken}` } });
const payload = (await history.json()) as {
  ok: boolean;
  error?: string;
  messages?: { text?: string; bot_id?: string; files?: { name?: string }[] }[];
};
if (!payload.ok) throw new Error(`conversations.history a échoué : ${payload.error}`);

const fromBot = (payload.messages ?? []).filter((m) => m.bot_id).reverse();

if (fromBot.length === 0) {
  console.log('❌ Aucune réponse du bot dans la fenêtre.');
  process.exit(1);
}

for (const message of fromBot) {
  console.log('─'.repeat(78));
  console.log(message.text ?? '(sans texte)');
  if (message.files?.length) {
    console.log(`  [fichiers] ${message.files.map((f) => f.name).join(', ')}`);
  }
}
console.log('─'.repeat(78));

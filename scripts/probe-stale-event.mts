/**
 * SONDE DE PRODUCTION — un événement périmé est-il bien écarté ?
 *
 * Vérifie le correctif du relevé où le bot a répondu à une question vieille d'1 h 40, dans
 * une conversation qui avait avancé depuis, en livrant au passage un document que plus
 * personne n'attendait.
 *
 * ⚠️ **Coûte ZÉRO token, dans les deux sens.** L'événement périmé est écarté dans `accept()`,
 * donc avant l'ACK et bien avant tout appel de modèle ; le témoin frais est une salutation
 * nue, donc un court-circuit déterministe. La sonde est répétable après chaque déploiement
 * sans entamer le budget de ≈ 19 messages/jour.
 *
 * Le TÉMOIN est la moitié du contrôle : sans lui, une sonde qui n'observe aucune réponse ne
 * distingue pas « la borne a fonctionné » de « le bot est mort ».
 *
 * Usage : npx tsx --env-file=.env scripts/probe-stale-event.mts
 */
import { createHmac } from 'node:crypto';
import { GREETING_REPLY } from '../src/shared/greeting';

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

const signingSecret = process.env.SLACK_SIGNING_SECRET;
const botToken = process.env.SLACK_BOT_TOKEN;
if (!signingSecret) throw new Error('SLACK_SIGNING_SECRET manquant');
if (!botToken) throw new Error('SLACK_BOT_TOKEN manquant');

async function send(text: string, ageMinutes: number, id: string): Promise<number> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    type: 'event_callback',
    team_id: 'TMLKC4EPP',
    event_id: id,
    // Le champ qui porte TOUT le contrôle : l'instant d'émission vu par Slack.
    event_time: nowSeconds - ageMinutes * 60,
    event: {
      type: 'message',
      channel,
      channel_type: 'im',
      user: REQUESTER,
      text,
      ts: (Date.now() / 1000).toFixed(6),
    },
  });

  // L'en-tête de signature reste FRAIS : sinon le rejet viendrait de `stale_timestamp`
  // (contrôle HMAC, 5 min) et non de la borne qu'on teste. Les deux sont distincts.
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature =
    'v0=' + createHmac('sha256', signingSecret!).update(`v0:${timestamp}:${body}`).digest('hex');

  const response = await fetch(`${baseUrl}/slack/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Slack-Request-Timestamp': timestamp,
      'X-Slack-Signature': signature,
    },
    body,
  });

  return response.status;
}

async function botMessagesSince(since: number): Promise<string[]> {
  const url = `https://slack.com/api/conversations.history?channel=${channel}&oldest=${since}&limit=30`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${botToken}` } });
  const payload = (await response.json()) as {
    ok: boolean;
    error?: string;
    messages?: { text?: string; bot_id?: string }[];
  };
  if (!payload.ok) throw new Error(`conversations.history a échoué : ${payload.error}`);
  return (payload.messages ?? []).filter((m) => m.bot_id).map((m) => m.text ?? '');
}

console.log(`Cible : ${baseUrl}/slack/events`);
console.log(`Canal : ${channel}\n`);

const since = Math.floor(Date.now() / 1000) - 1;
const stamp = Date.now();

const PERIME = `sonde périmée ${stamp} — cette réponse ne doit JAMAIS être postée`;

console.log(`→ événement de 100 minutes   ACK ${await send(PERIME, 100, `EvSTALE${stamp}`)}`);
// Espacé : la règle anti-rafale (5/min) s'applique toujours, elle, aux deux messages.
await new Promise((r) => setTimeout(r, 14_000));
console.log(`→ témoin frais (salutation)  ACK ${await send('bonjour', 0, `EvFRESH${stamp}`)}`);

await new Promise((r) => setTimeout(r, 10_000));

const posted = await botMessagesSince(since);

const perimeIgnore = !posted.some((t) => t.includes(String(stamp)));
const temoinRepondu = posted.some((t) => t === GREETING_REPLY);

console.log(`\n${posted.length} message(s) du bot dans la fenêtre.`);
console.log(
  perimeIgnore
    ? "✅ L'événement périmé n'a produit AUCUNE réponse."
    : '❌ Le périmé a reçu une réponse.',
);
console.log(
  temoinRepondu
    ? '✅ Le témoin frais a bien reçu la sienne — le bot est vivant.'
    : "❌ Le témoin frais est resté sans réponse : le contrôle ne prouve rien (bot muet ?).",
);

process.exit(perimeIgnore && temoinRepondu ? 0 : 1);

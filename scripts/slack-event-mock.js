/**
 * Simulateur d'événements Slack — exerce le VRAI chemin de vérification de signature.
 *
 * Usage (sans npm) :
 *   node --env-file=.env scripts/slack-event-mock.js
 *   node --env-file=.env scripts/slack-event-mock.js --url=https://kisso.vercel.app
 *   node --env-file=.env scripts/slack-event-mock.js --url=http://localhost:4111 --path=/slack/events
 *   SLACK_SIGNING_SECRET=xxx node scripts/slack-event-mock.js
 *
 * Options :
 *   --url=<origin>   Origine du serveur cible          (défaut: http://localhost:4111)
 *   --path=<path>    Chemin de l'endpoint Slack        (défaut: /slack/events)
 *   --verbose        Affiche les corps de réponse bruts
 *
 * Chaque scénario forge un `X-Slack-Signature` valide (HMAC-SHA256 sur
 * `v0:{timestamp}:{rawBody}`) à partir de SLACK_SIGNING_SECRET — sauf les scénarios
 * qui testent justement le rejet.
 *
 * Le script sort en code 1 si un scénario échoue.
 */
import { createHmac, randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const BASE_URL = (getArg('url', 'http://localhost:4111') || '').replace(/\/{1,8}$/, '');
const EVENTS_PATH = getArg('path', '/slack/events');
const VERBOSE = args.includes('--verbose');
const TARGET = `${BASE_URL}${EVENTS_PATH}`;

const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
if (!SIGNING_SECRET) {
  console.error(
    'SLACK_SIGNING_SECRET manquant. Lance avec: node --env-file=.env scripts/slack-event-mock.js',
  );
  process.exit(1);
}

const BOT_USER_ID = 'U0BMBEJTBMJ';
const BOT_ID = 'B0BM9MK4G65';
const TEAM_ID = 'TMLKC4EPP';
const HUMAN_USER_ID = 'U000HUMAN01';

function sign(timestamp, rawBody) {
  const digest = createHmac('sha256', SIGNING_SECRET)
    .update(`v0:${timestamp}:${rawBody}`, 'utf8')
    .digest('hex');
  return `v0=${digest}`;
}

async function post(payload, { timestamp, signature, retryNum } = {}) {
  const rawBody = JSON.stringify(payload);
  const ts = timestamp ?? String(Math.floor(Date.now() / 1000));
  const headers = {
    'content-type': 'application/json',
    'x-slack-request-timestamp': ts,
    'x-slack-signature': signature ?? sign(ts, rawBody),
  };
  if (retryNum !== undefined) {
    headers['x-slack-retry-num'] = String(retryNum);
    headers['x-slack-retry-reason'] = 'http_timeout';
  }

  const started = Date.now();
  const res = await fetch(TARGET, { method: 'POST', headers, body: rawBody });
  const elapsedMs = Date.now() - started;
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json, elapsedMs };
}

function eventCallback(event, eventId) {
  return {
    token: 'mock-verification-token',
    team_id: TEAM_ID,
    api_app_id: 'A0MOCKAPP',
    type: 'event_callback',
    event_id: eventId,
    event_time: Math.floor(Date.now() / 1000),
    authorizations: [
      {
        enterprise_id: null,
        team_id: TEAM_ID,
        user_id: BOT_USER_ID,
        is_bot: true,
        is_enterprise_install: false,
      },
    ],
    event,
  };
}

// `randomBytes` plutôt que `Math.random` : la valeur n'a rien de secret, mais un mock qui
// tire au sort avec un générateur non cryptographique est un motif qu'on finit par recopier
// là où ça compte. Le coût est identique.
const uniq = () =>
  `Ev${Date.now().toString(36).toUpperCase()}${randomBytes(3).toString('hex').toUpperCase()}`;

const scenarios = [
  {
    name: '(a) url_verification → renvoie le challenge',
    async run() {
      const challenge = `chal-${randomBytes(8).toString('hex')}`;
      const res = await post({ token: 'mock', challenge, type: 'url_verification' });
      const ok = res.status === 200 && res.json?.challenge === challenge;
      return { ok, res, expected: `200 + challenge "${challenge}"` };
    },
  },
  {
    name: '(b) app_mention dans un canal → accepté (200)',
    async run() {
      const res = await post(
        eventCallback(
          {
            type: 'app_mention',
            user: HUMAN_USER_ID,
            text: `<@${BOT_USER_ID}> peux-tu me donner le questionnaire d'onboarding ?`,
            ts: `${Date.now() / 1000}`,
            channel: 'C0MOCKCHAN',
            channel_type: 'channel',
            event_ts: `${Date.now() / 1000}`,
          },
          uniq(),
        ),
      );
      const ok = res.status === 200 && res.json?.ok === true;
      return { ok, res, expected: '200 {"ok":true}' };
    },
  },
  {
    name: "(c) message en DM (channel_type: 'im') → accepté (200)",
    async run() {
      const res = await post(
        eventCallback(
          {
            type: 'message',
            user: HUMAN_USER_ID,
            text: 'Bonjour, où en est mon onboarding ?',
            ts: `${Date.now() / 1000}`,
            channel: 'D0MOCKDM01',
            channel_type: 'im',
            event_ts: `${Date.now() / 1000}`,
          },
          uniq(),
        ),
      );
      const ok = res.status === 200 && res.json?.ok === true;
      return { ok, res, expected: '200 {"ok":true}' };
    },
  },
  {
    name: '(d) message du bot lui-même → ACK 200 mais ignoré (pas de boucle)',
    async run() {
      const res = await post(
        eventCallback(
          {
            type: 'message',
            subtype: 'bot_message',
            bot_id: BOT_ID,
            user: BOT_USER_ID,
            text: 'Réponse générée par le bot',
            ts: `${Date.now() / 1000}`,
            channel: 'D0MOCKDM01',
            channel_type: 'im',
            event_ts: `${Date.now() / 1000}`,
          },
          uniq(),
        ),
      );
      // Slack exige un 200 quoi qu'il arrive ; l'ignorance se voit dans les logs serveur
      // (`Slack event ignored { reason: 'bot_message' }`).
      const ok = res.status === 200 && res.json?.ok === true;
      return { ok, res, expected: '200 {"ok":true} + ignoré côté serveur (reason: bot_message)' };
    },
  },
  {
    name: '(e) signature invalide → rejeté 401',
    async run() {
      const res = await post(
        eventCallback(
          {
            type: 'app_mention',
            user: HUMAN_USER_ID,
            text: 'requête forgée',
            ts: `${Date.now() / 1000}`,
            channel: 'C0MOCKCHAN',
            channel_type: 'channel',
          },
          uniq(),
        ),
        { signature: `v0=${'0'.repeat(64)}` },
      );
      const ok = res.status === 401 && res.json?.reason === 'invalid_signature';
      return { ok, res, expected: '401 reason=invalid_signature' };
    },
  },
  {
    name: '(f) timestamp périmé (> 5 min) → rejeté 401',
    async run() {
      const staleTs = String(Math.floor(Date.now() / 1000) - 60 * 10);
      const res = await post(
        eventCallback(
          {
            type: 'app_mention',
            user: HUMAN_USER_ID,
            text: 'rejeu',
            ts: `${Date.now() / 1000}`,
            channel: 'C0MOCKCHAN',
            channel_type: 'channel',
          },
          uniq(),
        ),
        { timestamp: staleTs },
      );
      const ok = res.status === 401 && res.json?.reason === 'stale_timestamp';
      return { ok, res, expected: '401 reason=stale_timestamp' };
    },
  },
  {
    name: '(g) retry avec le même event_id → ACK 200 mais dédupliqué',
    async run() {
      const eventId = uniq();
      const event = {
        type: 'message',
        user: HUMAN_USER_ID,
        text: 'Envoie-moi un rappel demain',
        ts: `${Date.now() / 1000}`,
        channel: 'D0MOCKDM01',
        channel_type: 'im',
        event_ts: `${Date.now() / 1000}`,
      };
      const first = await post(eventCallback(event, eventId));
      const retry = await post(eventCallback(event, eventId), { retryNum: 1 });
      const ok =
        first.status === 200 &&
        first.json?.ok === true &&
        retry.status === 200 &&
        retry.json?.ok === true;
      return {
        ok,
        res: retry,
        expected:
          '200 sur les deux appels + 2e traité comme duplicate (reason: duplicate côté serveur)',
        extra: `1er appel: ${first.status} ${first.text}`,
      };
    },
  },
];

console.log(`Slack event mock → ${TARGET}`);
console.log(`Signing secret: présent (${SIGNING_SECRET.length} caractères)\n`);

let failures = 0;
for (const scenario of scenarios) {
  let outcome;
  try {
    outcome = await scenario.run();
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${scenario.name}`);
    console.log(`     erreur réseau: ${error.message}`);
    continue;
  }

  const label = outcome.ok ? 'PASS' : 'FAIL';
  if (!outcome.ok) failures += 1;
  console.log(`${label} ${scenario.name}`);
  console.log(`     attendu : ${outcome.expected}`);
  console.log(
    `     obtenu  : ${outcome.res.status} ${outcome.res.text} (${outcome.res.elapsedMs} ms)`,
  );
  if (outcome.extra) console.log(`     détail  : ${outcome.extra}`);
  if (VERBOSE) console.log(`     brut    : ${outcome.res.text}`);
}

console.log(`\n${scenarios.length - failures}/${scenarios.length} scénarios OK`);
if (failures > 0) {
  console.log('Note : les scénarios (d) et (g) vérifient un ACK 200 ; la preuve du filtrage');
  console.log('       se lit dans les logs serveur (`Slack event ignored`).');
}
process.exit(failures > 0 ? 1 : 0);

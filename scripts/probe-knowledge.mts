/**
 * SONDE DE PRODUCTION — l'ingestion de la base de connaissance, de bout en bout.
 *
 * ✅ **Elle ne coûte AUCUN token de modèle.** Elle envoie un `message.channels` signé, que
 * `rejectMessage` écarte (`not_a_dm`) : aucun agent n'est appelé. C'est précisément le chemin
 * qu'on veut vérifier — celui des messages qu'on archive sans y répondre.
 *
 * Ce qu'elle établit, dans l'ordre :
 *   1. la route accepte l'événement signé et ordonnance l'ingestion ;
 *   2. le niveau 1 (`channel_messages`) a bien la ligne, et son index FTS la retrouve ;
 *   3. le niveau 2 (`knowledge_facts`) a distillé le fait avec sa nature ;
 *   4. un message personnel (`im`) n'entre dans AUCUN des deux.
 *
 * ⚠️ Elle ÉCRIT dans la base de production, puis NETTOIE ses propres lignes. `--keep` les
 * conserve pour inspection manuelle.
 *
 * Usage : npx tsx --env-file=.env scripts/probe-knowledge.mts [--keep] [--url https://…]
 */
import { createHmac } from 'node:crypto';
import { createClient } from '@libsql/client';

import { makeDbExec } from './lib/resilient-db';

const DEFAULT_BASE_URL = 'https://mastra-71ya.vercel.app';
const REQUESTER = 'U0BJBDGTJUD';
const TEAM_ID = 'TMLKC4EPP';

const args = process.argv.slice(2);
const at = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const baseUrl = at('--url') ?? DEFAULT_BASE_URL;
const keep = args.includes('--keep');

const signingSecret = process.env.SLACK_SIGNING_SECRET;
const botToken = process.env.SLACK_BOT_TOKEN;
if (!signingSecret) throw new Error('SLACK_SIGNING_SECRET manquant');
if (!botToken) throw new Error('SLACK_BOT_TOKEN manquant');

const db = createClient({
  url: process.env.DATABASE_URL!,
  authToken: process.env.DATABASE_AUTH_TOKEN,
});

const dbExec = makeDbExec(db);

/**
 * Un canal RÉEL où le bot est membre — et, de préférence, LE DEMANDEUR AUSSI.
 *
 * ⚠️ Cette préférence n'est pas cosmétique. `searchKnowledge` filtre les résultats sur
 * l'appartenance du demandeur au canal : une sonde qui tombe sur un canal dont il n'est pas
 * membre rend `no_readable_channel` — verdict CORRECT, mais qui ne prouve pas que la
 * recherche fonctionne. « Un refus généralisé est indiscernable d'une frontière qui marche. »
 */
async function targetChannel(): Promise<{ id: string; name: string; requesterIsMember: boolean }> {
  const res = await fetch(
    'https://slack.com/api/users.conversations?types=public_channel,private_channel&limit=200',
    { headers: { authorization: `Bearer ${botToken}` } },
  );
  const body = (await res.json()) as {
    ok: boolean;
    error?: string;
    channels?: Array<{ id: string; name: string; is_archived: boolean }>;
  };
  if (!body.ok) throw new Error(`users.conversations: ${body.error}`);

  const alive = (body.channels ?? []).filter((c) => !c.is_archived);
  if (alive.length === 0) throw new Error("Le bot n'est membre d'aucun canal vivant.");

  const forced = at('--channel');
  if (forced) {
    const picked = alive.find((c) => c.id === forced || c.name === forced.replace(/^#/, ''));
    if (!picked) throw new Error(`Le bot n'est pas membre de ${forced}.`);
    return { ...picked, requesterIsMember: await isMember(picked.id) };
  }

  for (const candidate of alive) {
    if (await isMember(candidate.id)) {
      return { id: candidate.id, name: candidate.name, requesterIsMember: true };
    }
  }

  return { id: alive[0]!.id, name: alive[0]!.name, requesterIsMember: false };
}

async function isMember(channelId: string): Promise<boolean> {
  const res = await fetch(
    `https://slack.com/api/conversations.members?channel=${channelId}&limit=200`,
    { headers: { authorization: `Bearer ${botToken}` } },
  );
  const body = (await res.json()) as { ok: boolean; members?: string[] };
  return Boolean(body.ok && body.members?.includes(REQUESTER));
}

async function post(event: Record<string, unknown>): Promise<number> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    type: 'event_callback',
    team_id: TEAM_ID,
    event_id: `EvKB${Date.now()}${Math.floor(performance.now())}`,
    event_time: nowSeconds,
    event,
  });

  const timestamp = String(nowSeconds);
  const signature = `v0=${createHmac('sha256', signingSecret!).update(`v0:${timestamp}:${body}`).digest('hex')}`;

  const res = await fetch(`${baseUrl}/slack/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signature,
    },
    body,
  });

  return res.status;
}

const channel = await targetChannel();
console.log(
  `Canal cible : #${channel.name} (${channel.id}) — demandeur membre : ${channel.requesterIsMember}`,
);
if (!channel.requesterIsMember) {
  console.log(
    "⚠️  Le demandeur n'est PAS membre : `searchKnowledge` rendra `no_readable_channel`.\n" +
      '   Verdict correct, mais il ne prouve pas que la recherche fonctionne.',
  );
}
console.log();

const stamp = (Date.now() / 1000).toFixed(6);
const probeText = `On a décidé de reporter la sonde de connaissance à jeudi (marqueur ${stamp})`;
const archiveId = `${channel.id}:${stamp}`;

const dmStamp = (Date.now() / 1000 + 1).toFixed(6);
const dmText = `On a décidé que ce message privé ne doit JAMAIS être archivé (marqueur ${dmStamp})`;

console.log('1. message de CANAL (écarté pour la réponse, retenu pour la connaissance)');
console.log(
  '   HTTP',
  await post({
    type: 'message',
    channel: channel.id,
    channel_type: 'channel',
    user: REQUESTER,
    text: probeText,
    ts: stamp,
  }),
);

console.log('2. message PERSONNEL — ne doit entrer nulle part');
console.log(
  '   HTTP',
  await post({
    type: 'message',
    channel: 'D0BM9MK9QJV',
    channel_type: 'im',
    user: REQUESTER,
    text: dmText,
    ts: dmStamp,
    subtype: 'bot_message',
    bot_id: 'B0BM9MK4G65',
  }),
);

// La tâche de fond est ordonnancée par `waitUntil` : elle survit à la réponse HTTP, mais
// elle n'est pas terminée quand celle-ci arrive.
console.log('\nAttente de la tâche de fond…');
await new Promise((r) => setTimeout(r, 8000));

const results: Array<[string, boolean, string]> = [];

const level1 = await dbExec({
  sql: 'SELECT id, channel_id, slack_user_id, text FROM channel_messages WHERE id = ?',
  args: [archiveId],
});
results.push([
  'Niveau 1 — le message de canal est archivé',
  level1.rows.length === 1,
  level1.rows.length === 1 ? String(level1.rows[0]!.channel_id) : 'aucune ligne',
]);

const fts = await dbExec({
  sql: `SELECT m.id FROM channel_messages_fts f JOIN channel_messages m ON m.rowid = f.rowid
        WHERE channel_messages_fts MATCH '"sonde" OR "connaissance"' AND m.id = ?`,
  args: [archiveId],
});
results.push([
  'Niveau 1 — son index plein texte le retrouve',
  fts.rows.length === 1,
  `${fts.rows.length} correspondance(s)`,
]);

const level2 = await dbExec({
  sql: 'SELECT kind, summary, score FROM knowledge_facts WHERE id = ?',
  args: [archiveId],
});
results.push([
  'Niveau 2 — le fait est distillé, avec sa nature',
  level2.rows.length === 1 && level2.rows[0]!.kind === 'decision',
  level2.rows.length === 1
    ? `${level2.rows[0]!.kind} (score ${level2.rows[0]!.score})`
    : 'aucune ligne',
]);

const personal = await dbExec({
  sql: 'SELECT count(*) c FROM channel_messages WHERE text LIKE ?',
  args: [`%${dmStamp}%`],
});
const personalFacts = await dbExec({
  sql: 'SELECT count(*) c FROM knowledge_facts WHERE summary LIKE ?',
  args: [`%${dmStamp}%`],
});
results.push([
  "Le message personnel n'est entré dans AUCUN niveau",
  Number(personal.rows[0]!.c) === 0 && Number(personalFacts.rows[0]!.c) === 0,
  `niveau 1 : ${personal.rows[0]!.c}, niveau 2 : ${personalFacts.rows[0]!.c}`,
]);

console.log();
for (const [label, ok, detail] of results) {
  console.log(`${ok ? '✅' : '❌'} ${label} — ${detail}`);
}

if (!keep) {
  await dbExec({ sql: 'DELETE FROM knowledge_facts WHERE id = ?', args: [archiveId] });
  await dbExec({ sql: 'DELETE FROM channel_messages WHERE id = ?', args: [archiveId] });
  console.log('\nLignes de sonde supprimées.');
} else {
  console.log(`\n--keep : les lignes ${archiveId} sont conservées.`);
}

const failures = results.filter(([, ok]) => !ok).length;
if (failures > 0) process.exitCode = 1;

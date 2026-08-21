/**
 * SONDE DE PRODUCTION — l'effacement demandé est-il un GESTE ou une NARRATION ?
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Pourquoi cette sonde ne peut pas se contenter de lire la réponse
 * ════════════════════════════════════════════════════════════════════════════
 *
 * C'est tout l'objet du correctif qu'elle vérifie : avant lui, le bot RÉPONDAIT déjà
 * « c'est fait » — il ne faisait simplement rien. Une sonde qui se contenterait de
 * constater une réponse plausible validerait exactement le défaut. Elle compte donc les
 * lignes de `conversation_turns` AVANT et APRÈS, directement dans la base de production.
 *
 * ⚠️ **Cette sonde SUPPRIME des données réelles** — la mémoire conversationnelle du canal
 * visé. C'est de la donnée éphémère par construction (TTL de lecture de 60 minutes), et
 * c'est le geste même qu'on teste, mais il n'y a pas de retour en arrière. Elle affiche ce
 * qu'elle s'apprête à effacer et exige `--yes` pour le faire.
 *
 * Usage :
 *   npx tsx --env-file=.env scripts/probe-erasure.mts            # lecture seule
 *   npx tsx --env-file=.env scripts/probe-erasure.mts --yes      # effacement réel
 */
import { createHmac } from 'node:crypto';
import { createClient } from '@libsql/client';
import { ERASURE_SCOPE_NOTICE } from '../src/shared/forget';

const DEFAULT_BASE_URL = 'https://mastra-71ya.vercel.app';
const DEFAULT_CHANNEL = 'D0BM9MK9QJV';
const REQUESTER = 'U0BJBDGTJUD';

const args = process.argv.slice(2);
const confirmed = args.includes('--yes');
const at = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const baseUrl = at('--url') ?? DEFAULT_BASE_URL;
const channel = at('--channel') ?? DEFAULT_CHANNEL;

const signingSecret = process.env.SLACK_SIGNING_SECRET;
const botToken = process.env.SLACK_BOT_TOKEN;
const databaseUrl = process.env.DATABASE_URL;

if (!signingSecret) throw new Error('SLACK_SIGNING_SECRET manquant');
if (!botToken) throw new Error('SLACK_BOT_TOKEN manquant');
if (!databaseUrl) throw new Error('DATABASE_URL manquant');

const db = createClient({ url: databaseUrl, authToken: process.env.DATABASE_AUTH_TOKEN });

/** En DM la clé de conversation EST le canal — voir `deriveConversationId`. */
const conversationId = channel;

/**
 * ⚠️ **REPRISE SUR PANNE DE TRANSPORT — cette sonde est morte deux fois pour cette raison.**
 *
 * Le 2026-08-21, un `UND_ERR_CONNECT_TIMEOUT` vers Turso a tué ce script APRÈS qu'il eut posté
 * la demande d'effacement : le geste avait donc réellement eu lieu, et le verdict s'est perdu.
 * C'est le pire ordre possible — on a modifié la production et on ne sait pas dire ce qui s'est
 * passé, ce qui est exactement le mode de panne que ce dépôt traque dans le produit.
 *
 * `scripts/probe-arrival.mts` avait été durci contre cette même panne le matin même
 * (`resilientFetch` ne couvrait que Slack) ; le correctif n'avait pas été propagé ici. **Deux
 * sondes qui frappent la même base sans partager leur reprise finissent par diverger, et c'est
 * celle qu'on a oubliée qui perd le verdict.**
 */
async function dbExec(query: { sql: string; args: unknown[] }) {
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await db.execute(query as never);
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
  throw last;
}

/**
 * ⚠️ **L'ARCHIVE COMPTE AUSSI DEPUIS LE 2026-08-21.**
 *
 * Le court-circuit d'effacement ne touchait que `conversation_turns` et `pinned_facts` ; les
 * messages archivés dans `channel_messages` — **DM compris depuis le 2026-08-21, et relisibles
 * par le manager** — lui échappaient. Dire « c'est effacé » en les laissant serait un mensonge
 * par omission sur la donnée la plus sensible du lot.
 *
 * Cette sonde doit donc compter les DEUX. Sans quoi elle validerait, comme avant le correctif
 * qu'elle vérifie, une réponse plausible adossée à un geste partiel.
 *
 * ⚠️ Portée : ce CANAL. En DM c'est exactement ce que le court-circuit efface ; en fil de canal
 * il ne touche pas à l'archive, délibérément.
 */
async function countArchive(): Promise<number> {
  const rows = await dbExec({
    sql: 'SELECT COUNT(*) AS n FROM channel_messages WHERE channel_id = ? AND slack_user_id = ?',
    args: [channel, REQUESTER],
  });
  return Number(rows.rows[0]?.n ?? 0);
}

async function countTurns(): Promise<number> {
  const rows = await dbExec({
    sql: 'SELECT COUNT(*) AS n FROM conversation_turns WHERE conversation_id = ?',
    args: [conversationId],
  });
  return Number(rows.rows[0]?.n ?? 0);
}

async function post(text: string): Promise<number> {
  const ts = (Date.now() / 1000).toFixed(6);
  const body = JSON.stringify({
    type: 'event_callback',
    team_id: 'TMLKC4EPP',
    event_id: `EvERASE${Date.now()}`,
    event_time: Math.floor(Date.now() / 1000),
    event: { type: 'message', channel, channel_type: 'im', user: REQUESTER, text, ts },
  });

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

async function lastBotMessage(since: number): Promise<string | undefined> {
  const url = `https://slack.com/api/conversations.history?channel=${channel}&oldest=${since}&limit=20`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${botToken}` } });
  const payload = (await response.json()) as {
    ok: boolean;
    error?: string;
    messages?: { text?: string; bot_id?: string }[];
  };
  if (!payload.ok) throw new Error(`conversations.history a échoué : ${payload.error}`);
  return payload.messages?.find((m) => m.bot_id)?.text;
}

const before = await countTurns();
const archiveBefore = await countArchive();
console.log(`Cible        : ${baseUrl}/slack/events`);
console.log(`Conversation : ${conversationId}`);
console.log(`Tours en base AVANT     : ${before}`);
console.log(`Archive du canal AVANT  : ${archiveBefore}`);

if (!confirmed) {
  console.log(
    '\n⚠️ Lecture seule. Cette sonde SUPPRIME des données réelles ; relance avec --yes ' +
      "pour exécuter réellement la demande d'effacement.",
  );
  process.exit(0);
}

const since = Math.floor(Date.now() / 1000) - 1;
const status = await post("oublie ce que je t'ai dit");
console.log(`\n→ demande d'effacement   ACK ${status}`);

// Le traitement est en tâche de fond (`waitUntil`) : l'ACK ne dit rien de son issue.
await new Promise((resolve) => setTimeout(resolve, 8000));

const after = await countTurns();
const archiveAfter = await countArchive();
const reply = await lastBotMessage(since);

console.log(`Tours en base APRÈS     : ${after}`);
console.log(`Archive du canal APRÈS  : ${archiveAfter}`);
console.log(`Réponse postée      : ${reply ?? '(aucune)'}`);

const supprime = before > 0 && after === 0;
/**
 * ⚠️ **Un `0 → 0` sur l'archive n'est PAS une réussite, c'est une absence de preuve.** Si rien
 * n'était archivé avant, le nouveau chemin n'a pas été exercé et il faut le dire — c'est la
 * distinction `null` / `[]` que ce dépôt applique à `readToolCalls` : sans preuve positive,
 * on se tait plutôt que d'affirmer.
 */
const archiveEffacee = archiveBefore > 0 && archiveAfter === 0;
const archiveNonExercee = archiveBefore === 0;
const annonceLaPortee = Boolean(reply?.includes(ERASURE_SCOPE_NOTICE));

console.log('');
console.log(
  supprime ? '✅ Les données ont RÉELLEMENT été supprimées.' : "❌ Rien n'a été supprimé.",
);
console.log(
  archiveNonExercee
    ? "⚠️  Archive : rien n'était archivé avant — le chemin n'a PAS été exercé, ce n'est pas une réussite."
    : archiveEffacee
      ? `✅ L'archive du DM est partie aussi (${archiveBefore} → 0).`
      : `❌ L'archive du DM SUBSISTE (${archiveBefore} → ${archiveAfter}).`,
);
console.log(
  annonceLaPortee
    ? "✅ La réponse nomme ce que l'effacement ne couvre pas."
    : '❌ La réponse ne nomme pas la portée.',
);

process.exit(supprime && annonceLaPortee ? 0 : 1);

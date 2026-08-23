/**
 * ÉTAT DE LA BASE DE CONNAISSANCE — lecture seule, aucun token de modèle.
 *
 * Sert à répondre à la seule question que le code ne peut pas trancher tout seul : **Slack
 * livre-t-il réellement les messages de canal ?** L'abonnement `message.channels` /
 * `message.groups` vit dans la console Slack, pas dans ce dépôt. Le mode d'emploi est donc :
 * écrire une phrase dans un canal où le bot est membre, attendre dix secondes, lancer ceci.
 *
 * Si `channel_messages` reste à zéro alors que le chemin d'ingestion est vérifié
 * (`probe-knowledge.mts`), c'est l'abonnement qui manque — pas le code.
 *
 * Usage : npx tsx --env-file=.env scripts/knowledge-status.mts
 */
import { createClient } from '@libsql/client';

import { makeDbExec } from './lib/resilient-db';

const db = createClient({
  url: process.env.DATABASE_URL!,
  authToken: process.env.DATABASE_AUTH_TOKEN,
});

const dbExec = makeDbExec(db);

const [messages, facts] = await Promise.all([
  dbExec('SELECT count(*) c FROM channel_messages'),
  dbExec('SELECT count(*) c FROM knowledge_facts'),
]);

console.log(`Niveau 1 — channel_messages : ${messages.rows[0]!.c} ligne(s)`);
console.log(`Niveau 2 — knowledge_facts  : ${facts.rows[0]!.c} ligne(s)\n`);

const byChannel = await dbExec(`
  SELECT channel_id, count(*) n, max(posted_at) dernier
  FROM channel_messages GROUP BY channel_id ORDER BY n DESC LIMIT 10
`);

if (byChannel.rows.length === 0) {
  console.log('Aucun message archivé.');
  console.log('→ Écris une phrase dans un canal où le bot est membre, puis relance.');
  console.log("→ Si rien n'arrive : `message.channels` / `message.groups` ne sont pas abonnés.");
} else {
  console.log('Par canal :');
  for (const row of byChannel.rows) {
    const at = new Date(Number(row.dernier)).toISOString().slice(0, 16).replace('T', ' ');
    console.log(`  ${row.channel_id}  ${String(row.n).padStart(5)} message(s)   dernier : ${at}`);
  }
}

const latest = await dbExec(`
  SELECT kind, summary, posted_at FROM knowledge_facts ORDER BY posted_at DESC LIMIT 5
`);

if (latest.rows.length > 0) {
  console.log('\nDerniers faits retenus :');
  for (const row of latest.rows) {
    const at = new Date(Number(row.posted_at)).toISOString().slice(0, 10);
    console.log(`  [${at}] ${String(row.kind).padEnd(11)} ${String(row.summary).slice(0, 90)}`);
  }
}

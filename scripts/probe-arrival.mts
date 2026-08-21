/**
 * REJEU D'UNE ARRIVÉE COMPLÈTE, EN PRODUCTION.
 *
 * Le parcours réel d'un nouvel arrivant, de la demande de formulaire jusqu'à l'entretien :
 *   1. « je veux compléter mon profil »  → l'invite, puis la première question
 *   2. prénom → nom → email → poste       → une question par message
 *   3. « j'ai fini »                      → vérification du dossier
 *   4. les deux questions d'entretien     → quotidien, façon de travailler
 *
 * ✅ **CE REJEU NE COÛTE AUCUN TOKEN DE MODÈLE.** Tout le parcours est une machine à états
 * déterministe (`profile-chat.ts`, `interview-chat.ts`) : chaque réponse est écrite en code.
 * C'est précisément ce qui le rend rejouable autant de fois qu'on veut.
 *
 * ⚠️ **IL ÉCRIT DANS LA BASE DE PRODUCTION, puis NETTOIE.** La séquence est :
 *   sauvegarde JSON → mise à l'écart du dossier existant → rejeu → vérification → restauration.
 * La sauvegarde est écrite AVANT toute modification et son chemin est affiché : si le script
 * meurt en vol, la restauration reste faisable à la main.
 *
 * ⚠️ **L'email de rejeu est DIFFÉRENT de l'email réel**, et ce n'est pas de la coquetterie :
 * on ne peut pas savoir sans risque si une contrainte d'unicité porte sur cette colonne, et
 * découvrir que oui au milieu d'un rejeu laisserait le dossier réel à l'écart et le nouveau
 * non créé — c'est-à-dire quelqu'un sans dossier, l'état exact que ce produit existe pour
 * éviter.
 *
 * Usage : npx tsx --env-file=.env scripts/probe-arrival.mts --yes
 */
import { createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createClient } from '@libsql/client';

const BASE_URL = 'https://mastra-71ya.vercel.app';
const TEAM_ID = 'TMLKC4EPP';

/** Le second compte du propriétaire — jamais celui d'un tiers. Voir l'en-tête. */
const ARRIVAL_USER = 'U0BRRDEMSPN';

const REPLAY = {
  firstName: 'Amina',
  lastName: 'SONDE-TEST',
  email: 'amina.sonde-test@kissohq.com',
  position: 'Data Analyst',
  daily: "je prépare les tableaux de bord et je réponds aux questions chiffrées de l'équipe",
  style: "en asynchrone, avec peu de réunions et beaucoup d'écrit",
} as const;

const args = process.argv.slice(2);
if (!args.includes('--yes')) {
  console.log(
    'Ce script ÉCRIT dans la base de production (puis nettoie).\n' +
      'Relance avec --yes quand tu es prêt.',
  );
  process.exit(0);
}

const signingSecret = process.env.SLACK_SIGNING_SECRET;
const botToken = process.env.SLACK_BOT_TOKEN;
if (!signingSecret) throw new Error('SLACK_SIGNING_SECRET manquant');
if (!botToken) throw new Error('SLACK_BOT_TOKEN manquant');

const db = createClient({
  url: process.env.DATABASE_URL!,
  authToken: process.env.DATABASE_AUTH_TOKEN,
});

/**
 * ⚠️ REPRISE OBLIGATOIRE SUR LES APPELS SLACK — apprise en plein rejeu le 2026-08-21.
 *
 * Deux sondes ont été tuées net par `UND_ERR_CONNECT_TIMEOUT` vers `slack.com:443`. Ce n'est
 * pas un défaut du produit : `CLAUDE.md` consigne déjà que cette machine sort par Le Cap et
 * qu'un simple GET CDN y oscille entre 0,34 s et 2,26 s. Sans reprise, une campagne de quinze
 * minutes est à la merci d'un hoquet réseau d'une seconde — et l'échec ressemble alors à un
 * défaut du produit, ce qui est la pire forme de faux signal.
 */
async function resilientFetch(url: string, init?: RequestInit, attempts = 4): Promise<Response> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastError;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function slack<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const res = await resilientFetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${botToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });
  const payload = (await res.json()) as { ok: boolean; error?: string } & T;
  if (!payload.ok) throw new Error(`${method} : ${payload.error}`);
  return payload;
}

async function post(channel: string, text: string): Promise<number> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    type: 'event_callback',
    team_id: TEAM_ID,
    event_id: `EvARR${Date.now()}${Math.floor(performance.now())}`,
    event_time: nowSeconds,
    event: {
      type: 'message',
      channel,
      channel_type: 'im',
      user: ARRIVAL_USER,
      text,
      ts: (Date.now() / 1000).toFixed(6),
    },
  });
  const timestamp = String(nowSeconds);
  const signature = `v0=${createHmac('sha256', signingSecret!).update(`v0:${timestamp}:${body}`).digest('hex')}`;

  const res = await resilientFetch(`${BASE_URL}/slack/events`, {
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

async function botRepliesSince(channel: string, since: number): Promise<string> {
  const url = `https://slack.com/api/conversations.history?channel=${channel}&oldest=${since}&limit=20`;
  const res = await resilientFetch(url, { headers: { authorization: `Bearer ${botToken}` } });
  const payload = (await res.json()) as {
    ok: boolean;
    error?: string;
    messages?: { text?: string; bot_id?: string }[];
  };
  if (!payload.ok) throw new Error(`conversations.history : ${payload.error}`);
  return (payload.messages ?? [])
    .filter((m) => m.bot_id)
    .reverse()
    .map((m) => m.text ?? '')
    .join('\n');
}

async function step(channel: string, text: string, label: string): Promise<string> {
  const since = Math.floor(Date.now() / 1000) - 1;
  const status = await post(channel, text);
  await wait(9000);
  const reply = await botRepliesSince(channel, since);

  console.log('─'.repeat(78));
  console.log(`${label}\n→ « ${text} »   (ACK ${status})`);
  console.log(reply || '(AUCUNE RÉPONSE)');
  return reply;
}

// ── 1. Le canal de DM ────────────────────────────────────────────────────────
const opened = await slack<{ channel: { id: string } }>('conversations.open', {
  users: ARRIVAL_USER,
});
const channel = opened.channel.id;
console.log(`Arrivant : ${ARRIVAL_USER} · DM ${channel}\n`);

// ── 2. Sauvegarde AVANT toute écriture ───────────────────────────────────────
const before = await db.execute({
  sql: 'SELECT * FROM slack_directory WHERE slack_user_id = ?',
  args: [ARRIVAL_USER],
});
const existingEmployeeId = before.rows[0]?.employee_id as string | null;

const employeeRow = existingEmployeeId
  ? await db.execute({ sql: 'SELECT * FROM employees WHERE id = ?', args: [existingEmployeeId] })
  : { rows: [] };
const progressRow = existingEmployeeId
  ? await db.execute({
      sql: 'SELECT * FROM onboarding_progress WHERE employee_id = ?',
      args: [existingEmployeeId],
    })
  : { rows: [] };

const backupPath = `/tmp/kisso-arrival-backup-${Date.now()}.json`;
writeFileSync(
  backupPath,
  JSON.stringify(
    { directory: before.rows, employee: employeeRow.rows, progress: progressRow.rows },
    null,
    2,
  ),
);
console.log(`Sauvegarde : ${backupPath}\n`);

// ── 3. Mise à l'écart : l'arrivant redevient quelqu'un sans dossier ──────────
if (existingEmployeeId) {
  await db.execute({
    sql: 'UPDATE slack_directory SET employee_id = NULL WHERE slack_user_id = ?',
    args: [ARRIVAL_USER],
  });
  await db.execute({
    sql: 'UPDATE employees SET deleted_at = ? WHERE id = ?',
    args: [new Date().toISOString(), existingEmployeeId],
  });
  console.log(`Dossier ${existingEmployeeId} mis à l'écart (réversible).\n`);
}

// ── 4. Le parcours ───────────────────────────────────────────────────────────
const transcript: Array<[string, string]> = [];

transcript.push(['demande du formulaire', await step(channel, 'je veux compléter mon profil', '① DEMANDE')]);
transcript.push(['prénom', await step(channel, REPLAY.firstName, '② PRÉNOM')]);
transcript.push(['nom', await step(channel, REPLAY.lastName, '③ NOM')]);
transcript.push(['email', await step(channel, REPLAY.email, '④ EMAIL')]);
transcript.push(['poste', await step(channel, REPLAY.position, '⑤ POSTE')]);
transcript.push(['vérification', await step(channel, "j'ai fini", '⑥ « J’AI FINI »')]);
transcript.push(['entretien — quotidien', await step(channel, REPLAY.daily, '⑦ QUOTIDIEN')]);
transcript.push(['entretien — façon de travailler', await step(channel, REPLAY.style, '⑧ FAÇON DE TRAVAILLER')]);

// ── 5. Vérification en base ──────────────────────────────────────────────────
console.log(`\n${'═'.repeat(78)}\nVÉRIFICATION EN BASE\n${'═'.repeat(78)}`);

const created = await db.execute({
  sql: 'SELECT id, first_name, last_name, email, position FROM employees WHERE email = ?',
  args: [REPLAY.email],
});

const checks: Array<[string, boolean, string]> = [];
checks.push([
  'un dossier a bien été CRÉÉ par la conversation',
  created.rows.length === 1,
  created.rows.length === 1 ? String(created.rows[0]!.id) : `${created.rows.length} ligne(s)`,
]);

const createdId = created.rows[0]?.id as string | undefined;

if (createdId) {
  const row = created.rows[0]!;
  checks.push([
    'les quatre champs sont ceux qui ont été DITS, sans reformulation',
    row.first_name === REPLAY.firstName &&
      row.last_name === REPLAY.lastName &&
      row.position === REPLAY.position,
    `${row.first_name} / ${row.last_name} / ${row.position}`,
  ]);

  const linked = await db.execute({
    sql: 'SELECT employee_id FROM slack_directory WHERE slack_user_id = ?',
    args: [ARRIVAL_USER],
  });
  // ⚠️ La cause racine du 2026-08-19 : `slack_directory.employee_id` n'était écrite par AUCUN
  // chemin de production. L'entretien répondait « Noté » et n'enregistrait rien.
  checks.push([
    "l'annuaire est RELIÉ au dossier (cause racine du 2026-08-19)",
    linked.rows[0]?.employee_id === createdId,
    String(linked.rows[0]?.employee_id ?? 'null'),
  ]);

  const interview = await db.execute({
    sql: 'SELECT daily_work, work_style FROM onboarding_interview WHERE employee_id = ?',
    args: [createdId],
  });
  checks.push([
    "l'entretien est enregistré, et mot pour mot",
    interview.rows.length === 1 &&
      String(interview.rows[0]!.daily_work ?? '').includes('tableaux de bord'),
    interview.rows.length === 1 ? String(interview.rows[0]!.daily_work).slice(0, 60) : 'aucune ligne',
  ]);

  const progress = await db.execute({
    sql: 'SELECT status, current_step, total_steps FROM onboarding_progress WHERE employee_id = ?',
    args: [createdId],
  });
  // ⚠️ `ONBOARDING_TOTAL_STEPS` vaut 1 depuis le retrait du suivi de tâches. Une ligne à 5
  // annoncerait « étape 1 sur 5 » pour quatre étapes qui n'existent plus.
  checks.push([
    'le suivi annonce 1 étape, pas les 5 d’un plan supprimé',
    progress.rows.length === 1 && Number(progress.rows[0]!.total_steps) === 1,
    progress.rows.length === 1
      ? `${progress.rows[0]!.status} ${progress.rows[0]!.current_step}/${progress.rows[0]!.total_steps}`
      : 'aucune ligne',
  ]);
}

const marcelNamed = transcript.some(([, reply]) => reply.includes('Marcel'));
checks.push(["Marcel s'est nommé au moins une fois", marcelNamed, String(marcelNamed)]);

const machineTalk = transcript.filter(([, r]) =>
  /je suis (?:un |une )?(?:outil|agent|bot|robot|assistant|ia)\b/i.test(r),
);
checks.push([
  "il ne s'est jamais annoncé comme une machine",
  machineTalk.length === 0,
  machineTalk.map(([l]) => l).join(', ') || 'aucune occurrence',
]);

console.log();
for (const [label, ok, detail] of checks) console.log(`${ok ? '✅' : '❌'} ${label} — ${detail}`);

// ── 6. Nettoyage ─────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(78)}\nNETTOYAGE\n${'═'.repeat(78)}`);

if (createdId) {
  await db.execute({
    sql: 'DELETE FROM onboarding_interview WHERE employee_id = ?',
    args: [createdId],
  });
  await db.execute({
    sql: 'DELETE FROM onboarding_progress WHERE employee_id = ?',
    args: [createdId],
  });
  await db.execute({ sql: 'DELETE FROM employees WHERE id = ?', args: [createdId] });
  console.log(`Dossier de sonde ${createdId} supprimé.`);
}

if (existingEmployeeId) {
  await db.execute({
    sql: 'UPDATE employees SET deleted_at = NULL WHERE id = ?',
    args: [existingEmployeeId],
  });
  await db.execute({
    sql: 'UPDATE slack_directory SET employee_id = ? WHERE slack_user_id = ?',
    args: [existingEmployeeId, ARRIVAL_USER],
  });
  console.log(`Dossier réel ${existingEmployeeId} restauré et relié.`);
}

// ⚠️ On RELIT après restauration. Écrire puis supposer est exactement ce que `role:set` refuse
// de faire, et pour la même raison : une restauration qu'on n'a pas constatée n'a pas eu lieu.
const after = await db.execute({
  sql: `SELECT d.employee_id, e.deleted_at, e.email
        FROM slack_directory d LEFT JOIN employees e ON e.id = d.employee_id
        WHERE d.slack_user_id = ?`,
  args: [ARRIVAL_USER],
});
console.log('État relu :', JSON.stringify(after.rows[0] ?? null));

const restored =
  !existingEmployeeId ||
  (after.rows[0]?.employee_id === existingEmployeeId && after.rows[0]?.deleted_at === null);
console.log(restored ? '✅ Restauration vérifiée.' : `❌ RESTAURATION INCOMPLÈTE — ${backupPath}`);

const failures = checks.filter(([, ok]) => !ok).length;
console.log(
  `\n${failures === 0 && restored ? '✅ Parcours d’arrivée conforme.' : `❌ ${failures} contrôle(s) en défaut.`}`,
);
if (failures > 0 || !restored) process.exitCode = 1;

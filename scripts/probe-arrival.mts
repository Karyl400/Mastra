/**
 * REJEU D'UNE ARRIVÉE COMPLÈTE, EN PRODUCTION — happy flow ET cas limites.
 *
 * ✅ **CE REJEU NE COÛTE AUCUN TOKEN DE MODÈLE.** Tout le parcours est une machine à états
 * déterministe (`profile-chat.ts`, `interview-chat.ts`) : chaque réponse est écrite en code.
 * C'est précisément ce qui le rend rejouable autant de fois qu'on veut.
 *
 * ⚠️ **IL EST PILOTÉ PAR LA QUESTION POSÉE, PLUS PAR UN SCRIPT FIGÉ — et c'est la correction
 * du 2026-08-21.** La première version envoyait prénom / nom / email / poste dans cet ordre.
 * Or `knownProfileAnswers` pré-remplit le dossier depuis `slack_directory` : le bot demandait
 * en réalité le NOM en premier, si bien que « Amina » partait en nom de famille, « SONDE-TEST »
 * en poste, et l'email de rejeu n'était JAMAIS demandé. Tout le parcours était décalé d'un cran,
 * et l'assertion finale portait sur une adresse que rien n'avait employée.
 *
 * ⚠️ Le défaut de fond était plus grave que le décalage : **une sonde qui suppose la question
 * ne mesure pas le produit, elle mesure sa propre supposition.** Elle relit donc désormais la
 * réponse du bot avec `pendingProfileStep` / `pendingInterviewStep` — les fonctions MÊMES que
 * le handler utilise, importées, jamais recopiées.
 *
 * ⚠️ **IL ÉCRIT DANS LA BASE DE PRODUCTION, puis NETTOIE.** La séquence est :
 *   sauvegarde JSON → mise à l'écart → rejeu → vérification → restauration → RELECTURE.
 * La sauvegarde est écrite AVANT toute modification et son chemin est affiché : si le script
 * meurt en vol, la restauration reste faisable à la main.
 *
 * ⚠️ **L'identité d'annuaire est mise de côté elle aussi** (prénom, nom, email), et pas par
 * confort : tant qu'elle est là, le bot ne pose que les questions qui restent, donc la sonde
 * ne peut vérifier ni la saisie, ni les refus, ni la reprise sur erreur. Elle est restaurée
 * depuis la sauvegarde, colonne par colonne.
 *
 * Usage : npx tsx --env-file=.env scripts/probe-arrival.mts --yes
 */
import { createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createClient } from '@libsql/client';

import {
  pendingProfileStep,
  type ProfileStep,
} from '../src/features/onboarding/domain/services/profile-chat.js';
import {
  INTERVIEW_TOO_SHORT_REPLY,
  pendingInterviewStep,
} from '../src/features/onboarding/domain/services/interview-chat.js';

const BASE_URL = 'https://mastra-71ya.vercel.app';
const TEAM_ID = 'TMLKC4EPP';

/** Le second compte du propriétaire — jamais celui d'un tiers. Voir l'en-tête. */
const ARRIVAL_USER = 'U0BRRDEMSPN';

const REPLAY: Readonly<Record<ProfileStep, string>> = {
  firstName: 'Amina',
  lastName: 'SONDE-TEST',
  email: 'amina.sonde-test@kissohq.com',
  position: 'Data Analyst',
};

const INTERVIEW = {
  dailyWork: "je prépare les tableaux de bord et je réponds aux questions chiffrées de l'équipe",
  workStyle: "en asynchrone, avec peu de réunions et beaucoup d'écrit",
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
async function resilientFetch(url: string, init?: RequestInit, attempts = 10): Promise<Response> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
  throw lastError;
}

/**
 * ⚠️ **LA REPRISE VAUT AUSSI POUR TURSO, et l'oubli a coûté une base laissée sale.**
 *
 * `resilientFetch` ne couvrait que Slack. Un `UND_ERR_CONNECT_TIMEOUT` vers
 * `…turso.io:443` a tué le rejeu en plein parcours, laissant le dossier réel archivé et
 * l'annuaire vidé de son identité — réparé à la main depuis la sauvegarde. La machine qui
 * lance cette sonde sort par Le Cap ; un hoquet d'une seconde n'est pas un événement rare.
 */
async function dbExec(
  statement: { sql: string; args: unknown[] },
  attempts = 5,
): Promise<{ rows: Record<string, unknown>[]; rowsAffected: number }> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return (await db.execute(statement as never)) as never;
    } catch (error) {
      lastError = error;
      console.log(`  ⏳ base injoignable (${i + 1}/${attempts}) — nouvelle tentative`);
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
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

const transcript: Array<[string, string]> = [];

/**
 * ⚠️ **LA SONDE DOIT RESPECTER `BURST_RULE`, ET ELLE NE LE FAISAIT PAS — 2026-08-21.**
 *
 * Le premier rejeu a déraillé sur « Tu m'écris plus vite que je ne sais répondre ». Ce n'était
 * pas un défaut du produit : `BURST_RULE` autorise 5 messages par minute et s'applique à TOUT,
 * y compris aux court-circuits gratuits — délibérément, « une rafale reste une rafale, quel que
 * soit le quota derrière ». La sonde postait toutes les 9 secondes, soit 6,7 par minute.
 *
 * C'est le pire genre de faux signal : le parcours suivant partait d'un état que la sonde
 * croyait établi, et six contrôles rougissaient en désignant des causes imaginaires. Un cadre
 * qui ne respecte pas les règles du produit ne mesure pas le produit.
 *
 * D'où DEUX gardes : une cadence sous la limite (5 par minute ⇒ un message toutes les 12 s au
 * plus vite), et la RECONNAISSANCE du refus de rafale, qui attend puis rejoue le tour au lieu
 * de le compter comme une réponse.
 */
const BURST_PATTERN = /plus vite que je ne sais répondre|laisse-moi une minute/i;
const PACE_MS = 14_000;

async function say(channel: string, text: string, label: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const since = Math.floor(Date.now() / 1000) - 1;
    const status = await post(channel, text);
    await wait(PACE_MS);
    const reply = await botRepliesSince(channel, since);

    if (BURST_PATTERN.test(reply)) {
      console.log(`⏳ rafale détectée sur « ${label} » — pause de 65 s puis nouvelle tentative`);
      await wait(65_000);
      continue;
    }

    console.log('─'.repeat(78));
    console.log(
      `${label}\n→ « ${text.length > 90 ? `${text.slice(0, 90)}…` : text} »   (ACK ${status})`,
    );
    console.log(reply || '(AUCUNE RÉPONSE)');
    transcript.push([label, reply]);
    return reply;
  }

  throw new Error(`Rafale persistante sur « ${label} » — le rejeu est interrompu.`);
}

const checks: Array<[string, boolean, string]> = [];
const record = (label: string, ok: boolean, detail: string) => checks.push([label, ok, detail]);

// ── 1. Le canal de DM ────────────────────────────────────────────────────────
const opened = await slack<{ channel: { id: string } }>('conversations.open', {
  users: ARRIVAL_USER,
});
const channel = opened.channel.id;
console.log(`Arrivant : ${ARRIVAL_USER} · DM ${channel}\n`);

// ── 2. Sauvegarde AVANT toute écriture ───────────────────────────────────────
const before = await dbExec({
  sql: 'SELECT * FROM slack_directory WHERE slack_user_id = ?',
  args: [ARRIVAL_USER],
});
const directoryRow = before.rows[0];
if (!directoryRow) throw new Error(`Aucune ligne d'annuaire pour ${ARRIVAL_USER}`);

const existingEmployeeId = directoryRow.employee_id as string | null;
const realIdentity = {
  first_name: (directoryRow.first_name ?? null) as string | null,
  last_name: (directoryRow.last_name ?? null) as string | null,
  email: (directoryRow.email ?? null) as string | null,
};

const employeeRow = existingEmployeeId
  ? await dbExec({ sql: 'SELECT * FROM employees WHERE id = ?', args: [existingEmployeeId] })
  : { rows: [] };
const progressRow = existingEmployeeId
  ? await dbExec({
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

/**
 * ⚠️ **LE NETTOYAGE DOIT AVOIR LIEU MÊME QUAND LE REJEU MEURT — appris deux fois le même jour.**
 *
 * Le parcours vit donc dans une fonction, appelée sous `try`, et la restauration dans le
 * `finally`. Elle ne s'appuie sur AUCUNE variable calculée par le parcours : le dossier de
 * sonde est retrouvé par son adresse, qui est une constante de ce fichier. Une restauration
 * qui dépendrait de l'endroit où le script est mort ne se déclencherait jamais au moment où
 * elle sert.
 */
async function runJourney(): Promise<void> {
  // ── 3. Mise à l'écart : l'arrivant redevient quelqu'un sans dossier ──────────
  if (existingEmployeeId) {
    await dbExec({
      sql: 'UPDATE slack_directory SET employee_id = NULL WHERE slack_user_id = ?',
      args: [ARRIVAL_USER],
    });
    await dbExec({
      sql: 'UPDATE employees SET deleted_at = ? WHERE id = ?',
      args: [new Date().toISOString(), existingEmployeeId],
    });
    console.log(`Dossier ${existingEmployeeId} mis à l'écart (réversible).`);
  }

  /**
   * ⚠️ **CET ÉTAT-CI EST LE CAS LIMITE, PAS UN ARTEFACT DE SONDE.** Awa TRAORE est dans
   * exactement cette situation depuis le 2026-08-12 : une adresse d'annuaire qui pointe vers un
   * dossier archivé. L'index unique `idx_employees_email` n'a PAS de prédicat `deleted_at`, là
   * où les trois résolveurs en ont un — refaire le parcours donne donc éternellement le même
   * conflit, et le message générique (« réessaie ») enfermait dans une boucle sans sortie.
   */
  console.log(
    `\n${'═'.repeat(78)}\nCAS LIMITE — l’adresse est tenue par un dossier ARCHIVÉ\n${'═'.repeat(78)}`,
  );

  await say(channel, "oublie ce que je t'ai dit", '⟲ remise à zéro du fil');

  let reply = await say(channel, 'je veux compléter mon profil', '① demande du formulaire');
  for (let guard = 0; guard < 6; guard += 1) {
    const step = pendingProfileStep(reply);
    if (!step) break;
    // Le poste n'est pas dans l'annuaire : c'est la seule question qui reste ici.
    reply = await say(channel, REPLAY[step], `→ ${step}`);
  }

  record(
    'une adresse tenue par un dossier archivé est NOMMÉE comme telle, et renvoie à Nazer',
    /archiv/i.test(reply) && reply.includes('Nazer'),
    reply.slice(0, 110).replace(/\n/g, ' '),
  );
  record(
    'elle ne propose PAS de recommencer — ce serait la boucle sans sortie',
    !/recommence|r[ée]essaie/i.test(reply),
    reply.slice(0, 80).replace(/\n/g, ' '),
  );

  // ── 4. Le parcours nominal, identité d'annuaire mise de côté ─────────────────
  console.log(
    `\n${'═'.repeat(78)}\nPARCOURS NOMINAL — les quatre questions sont réellement posées\n${'═'.repeat(78)}`,
  );

  await dbExec({
    sql: 'UPDATE slack_directory SET first_name = NULL, last_name = NULL, email = NULL WHERE slack_user_id = ?',
    args: [ARRIVAL_USER],
  });

  await say(channel, "oublie ce que je t'ai dit", '⟲ remise à zéro du fil');

  // Un arrivant dit bonjour avant de remplir quoi que ce soit. C'est aussi le seul moment du
  // parcours où Marcel se nomme — le contrôle de persona porterait sinon sur rien.
  await say(channel, 'bonjour', '⓪ salutation');

  reply = await say(channel, 'je veux compléter mon profil', '① demande du formulaire');
  record(
    'la première question posée est bien le PRÉNOM',
    pendingProfileStep(reply) === 'firstName',
    String(pendingProfileStep(reply)),
  );

  // ⚠️ Cas limite — un refus ne doit pas être capté comme une valeur. Sans ça, « je ne sais pas »
  // deviendrait un prénom, imprimé tel quel dans un document qui porte le nom de la personne.
  reply = await say(channel, 'je ne sais pas', '⚠ refus — ne doit RIEN capter');
  record(
    'un refus ne devient pas un prénom : la même question est reposée',
    pendingProfileStep(reply) === 'firstName',
    String(pendingProfileStep(reply)),
  );

  const asked: ProfileStep[] = [];
  let emailRetryDone = false;
  for (let guard = 0; guard < 10; guard += 1) {
    const step = pendingProfileStep(reply);
    if (!step) break;
    asked.push(step);

    // ⚠️ Cas limite — une adresse mal formée doit être REDEMANDÉE avec de quoi la corriger,
    // jamais acceptée : c'est la seule clé de rapprochement du dossier.
    if (step === 'email' && !emailRetryDone) {
      emailRetryDone = true;
      const retry = await say(channel, 'amina point sonde arobase kissohq', '⚠ email mal formé');
      record(
        'une adresse mal formée est redemandée, et la réponse dit ce qui manque',
        pendingProfileStep(retry) === 'email' && retry.includes('@'),
        retry.slice(0, 90).replace(/\n/g, ' '),
      );
    }

    reply = await say(channel, REPLAY[step], `→ ${step}`);
  }

  record(
    'les quatre questions ont été posées, dans l’ordre',
    asked.join(',') === 'firstName,lastName,email,position',
    asked.join(' → '),
  );

  // ── 5. Vérification du dossier créé ─────────────────────────────────────────
  const created = await dbExec({
    sql: 'SELECT id, first_name, last_name, email, position FROM employees WHERE email = ?',
    args: [REPLAY.email],
  });

  record(
    'un dossier a bien été CRÉÉ par la conversation',
    created.rows.length === 1,
    created.rows.length === 1 ? String(created.rows[0]!.id) : `${created.rows.length} ligne(s)`,
  );

  const createdId = created.rows[0]?.id as string | undefined;

  if (createdId) {
    const row = created.rows[0]!;
    record(
      'les quatre champs sont ceux qui ont été DITS, sans reformulation',
      row.first_name === REPLAY.firstName &&
        row.last_name === REPLAY.lastName &&
        row.position === REPLAY.position,
      `${row.first_name} / ${row.last_name} / ${row.position}`,
    );

    const linked = await dbExec({
      sql: 'SELECT employee_id FROM slack_directory WHERE slack_user_id = ?',
      args: [ARRIVAL_USER],
    });
    // ⚠️ La cause racine du 2026-08-19 : `slack_directory.employee_id` n'était écrite par AUCUN
    // chemin de production. L'entretien répondait « Noté » et n'enregistrait rien.
    record(
      "l'annuaire est RELIÉ au dossier (cause racine du 2026-08-19)",
      linked.rows[0]?.employee_id === createdId,
      String(linked.rows[0]?.employee_id ?? 'null'),
    );
  }

  // ── 6. L'ENTRETIEN, qui s'enchaîne tout seul, PUIS « j'ai fini » ────────────
  //
  // ⚠️ L'ordre importe, et la première version l'avait faux : la création du dossier enchaîne
  // DIRECTEMENT sur la première question d'entretien. Envoyer « j'ai fini » à ce moment-là
  // écrasait l'entretien avant qu'il ait commencé, et la sonde imputait ensuite au produit une
  // absence de ligne d'entretien qu'elle avait elle-même provoquée.
  console.log(
    `\n${'═'.repeat(78)}\nL’ENTRETIEN, PUIS LA VÉRIFICATION DU DOSSIER\n${'═'.repeat(78)}`,
  );

  // ⚠️ Cas limite — une réponse trop courte ne doit pas devenir la description du métier de
  // quelqu'un : ce champ est IMPRIMÉ dans un document qui porte son nom.
  if (pendingInterviewStep(reply)) {
    const tooShort = await say(channel, 'ok', '⚠ réponse trop courte');
    record(
      'une réponse trop courte est refusée sans perdre la question',
      tooShort.includes(INTERVIEW_TOO_SHORT_REPLY.slice(0, 30)),
      tooShort.slice(0, 80).replace(/\n/g, ' '),
    );
    reply = tooShort;
  }

  for (let guard = 0; guard < 4; guard += 1) {
    const step = pendingInterviewStep(reply);
    if (!step) break;
    reply = await say(channel, INTERVIEW[step], `→ entretien : ${step}`);
  }

  reply = await say(channel, "j'ai fini", '⑥ « j’ai fini »');
  record(
    'le verdict de complétion ne redemande pas un dossier qui existe',
    !reply.includes('Je ne trouve pas encore de dossier'),
    reply.slice(0, 90).replace(/\n/g, ' '),
  );

  // ⚠️ **CE CONTRÔLE VIENT D'UN DÉFAUT TROUVÉ PAR CETTE SONDE, en production le 2026-08-21.**
  // L'annuaire n'a pas d'email ici (mis de côté), mais `submitProfile` a RELIÉ `employee_id`.
  // Les deux lecteurs du dossier ne passaient que par l'adresse : « Je ne trouve pas encore de
  // dossier à ton nom » juste après l'avoir créé, avec l'identifiant sous les yeux.
  record(
    "le dossier se retrouve par son LIEN, sans adresse dans l'annuaire",
    reply.includes('complet') || !reply.includes('Je ne trouve pas'),
    reply.slice(0, 70).replace(/\n/g, ' '),
  );

  if (createdId) {
    const interview = await dbExec({
      sql: 'SELECT daily_work, work_style FROM onboarding_interview WHERE employee_id = ?',
      args: [createdId],
    });
    record(
      "l'entretien est enregistré, et mot pour mot",
      interview.rows.length === 1 &&
        String(interview.rows[0]!.daily_work ?? '').includes('tableaux de bord'),
      interview.rows.length === 1
        ? String(interview.rows[0]!.daily_work).slice(0, 60)
        : 'aucune ligne',
    );

    const progress = await dbExec({
      sql: 'SELECT status, current_step, total_steps FROM onboarding_progress WHERE employee_id = ?',
      args: [createdId],
    });
    // ⚠️ `ONBOARDING_TOTAL_STEPS` vaut 1 depuis le retrait du suivi de tâches. Une ligne à 5
    // annoncerait « étape 1 sur 5 » pour quatre étapes qui n'existent plus.
    record(
      'le suivi annonce 1 étape, pas les 5 d’un plan supprimé',
      progress.rows.length === 1 && Number(progress.rows[0]!.total_steps) === 1,
      progress.rows.length === 1
        ? `${progress.rows[0]!.status} ${progress.rows[0]!.current_step}/${progress.rows[0]!.total_steps}`
        : 'aucune ligne',
    );
  }

  // ── 7. Le ton, sur l'ensemble du parcours ───────────────────────────────────
  const whole = transcript.map(([, r]) => r).join('\n');
  record(
    "Marcel s'est nommé au moins une fois",
    whole.includes('Marcel'),
    String(whole.includes('Marcel')),
  );

  const machineTalk = transcript.filter(([, r]) =>
    /je suis (?:un |une )?(?:outil|agent|bot|robot|assistant|ia)\b/i.test(r),
  );
  record(
    "il ne s'est jamais annoncé comme une machine",
    machineTalk.length === 0,
    machineTalk.map(([l]) => l).join(', ') || 'aucune occurrence',
  );

  // ⚠️ Les textes en dur ne passent par AUCUN filtre : `sanitizeAgentOutput` n'a qu'un seul site
  // d'appel, `response.text`. Un `**gras**` s'afficherait littéralement — constaté le 2026-08-18.
  record(
    'aucun markdown GitHub dans les réponses déterministes',
    !whole.includes('**'),
    whole.includes('**') ? 'un ** est sorti tel quel' : 'aucun',
  );
}

try {
  await runJourney();
} catch (error) {
  console.error(`\n❌ REJEU INTERROMPU : ${String(error).slice(0, 200)}`);
  process.exitCode = 1;
}

console.log(`\n${'═'.repeat(78)}\nVÉRIFICATION\n${'═'.repeat(78)}\n`);
for (const [label, ok, detail] of checks) console.log(`${ok ? '✅' : '❌'} ${label} — ${detail}`);

// ── 8. Nettoyage ────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(78)}\nNETTOYAGE\n${'═'.repeat(78)}`);

/**
 * ⚠️ **L'ORDRE DU NETTOYAGE A COÛTÉ UNE BASE DE PRODUCTION LAISSÉE SALE — 2026-08-21.**
 *
 * La première version supprimait le dossier de sonde AVANT de rendre l'annuaire à son vrai
 * dossier. Or `slack_directory.employee_id` pointait encore sur la sonde :
 * `FOREIGN KEY constraint failed`, le script mourait, et le dossier réel restait archivé,
 * l'annuaire vidé de son identité. Il a fallu réparer à la main depuis la sauvegarde.
 *
 * On RESTAURE donc d'abord — c'est ce qui relâche la référence — puis on purge. Et l'on purge
 * TOUT ce qui pend au dossier de sonde : l'email de bienvenue crée une ligne `notifications`
 * que la première version ignorait.
 */
// ⚠️ Retrouvé PAR SON ADRESSE, jamais par une variable du parcours : si le rejeu meurt entre
// la création du dossier et son enregistrement dans une variable, le nettoyage doit quand même
// savoir quoi purger. L'adresse est une constante de ce fichier — elle, elle est toujours là.
const leftovers = await dbExec({
  sql: 'SELECT id FROM employees WHERE email = ?',
  args: [REPLAY.email],
});
const createdId = leftovers.rows[0]?.id as string | undefined;

if (existingEmployeeId) {
  await dbExec({
    sql: 'UPDATE employees SET deleted_at = NULL WHERE id = ?',
    args: [existingEmployeeId],
  });
}

await dbExec({
  sql: 'UPDATE slack_directory SET first_name = ?, last_name = ?, email = ?, employee_id = ? WHERE slack_user_id = ?',
  args: [
    realIdentity.first_name,
    realIdentity.last_name,
    realIdentity.email,
    existingEmployeeId,
    ARRIVAL_USER,
  ],
});
if (existingEmployeeId) console.log(`Dossier réel ${existingEmployeeId} restauré et relié.`);

if (createdId) {
  for (const [table, column] of [
    ['onboarding_interview', 'employee_id'],
    ['onboarding_progress', 'employee_id'],
    ['notifications', 'recipient_id'],
    ['documents', 'employee_id'],
  ] as const) {
    await dbExec({ sql: `DELETE FROM ${table} WHERE ${column} = ?`, args: [createdId] }).catch(
      (error) => console.log(`  ${table} : ${String(error).slice(0, 60)}`),
    );
  }
  await dbExec({ sql: 'DELETE FROM employees WHERE id = ?', args: [createdId] });
  console.log(`Dossier de sonde ${createdId} supprimé, dépendances comprises.`);
}

/**
 * ⚠️ **L'ARCHIVE AUSSI — et elle manquait, constaté le 2026-08-21 au soir.**
 *
 * Le nettoyage suivait les dépendances du DOSSIER (`employee_id`, `recipient_id`) et ignorait
 * `channel_messages`, qui n'est indexée ni par l'un ni par l'autre mais par le **canal et
 * l'auteur Slack**. Douze messages de sonde étaient donc restés dans l'archive de production
 * après un passage — et depuis le 2026-08-21 cette table est lisible par le manager.
 *
 * ⚠️ **Une sonde qui laisse des traces fausse la mesure suivante** : ces douze lignes auraient
 * été distillées en faits, puis rendues par `searchKnowledge` comme si quelqu'un les avait
 * vraiment écrites. Une sonde doit rendre la base telle qu'elle l'a trouvée, et la vérifier —
 * c'est déjà la règle appliquée au dossier, elle n'avait simplement pas suivi la table
 * nouvelle.
 *
 * Portée : ce canal (`channel`, le DM ouvert plus haut) et cet auteur, jamais plus large. Les faits partent avant les messages,
 * même ordre que `KnowledgeErasureService` — un résumé sans sa source est pire qu'aucun des deux.
 */
for (const table of ['knowledge_facts', 'channel_messages'] as const) {
  const removed = await dbExec({
    sql: `DELETE FROM ${table} WHERE slack_user_id = ? AND channel_id = ?`,
    args: [ARRIVAL_USER, channel],
  })
    .then((r) => r.rowsAffected)
    .catch(() => -1);
  if (removed > 0) console.log(`Archive nettoyée : ${removed} ligne(s) de ${table}.`);
}

// ⚠️ On RELIT après restauration. Écrire puis supposer est exactement ce que `role:set` refuse
// de faire, et pour la même raison : une restauration qu'on n'a pas constatée n'a pas eu lieu.
const after = await dbExec({
  sql: `SELECT d.employee_id, d.first_name, d.last_name, d.email AS dir_email, e.deleted_at
        FROM slack_directory d LEFT JOIN employees e ON e.id = d.employee_id
        WHERE d.slack_user_id = ?`,
  args: [ARRIVAL_USER],
});
console.log('État relu :', JSON.stringify(after.rows[0] ?? null));

const back = after.rows[0];
const restored =
  back?.first_name === realIdentity.first_name &&
  back?.last_name === realIdentity.last_name &&
  back?.dir_email === realIdentity.email &&
  (!existingEmployeeId || (back?.employee_id === existingEmployeeId && back?.deleted_at === null));
console.log(restored ? '✅ Restauration vérifiée.' : `❌ RESTAURATION INCOMPLÈTE — ${backupPath}`);

const failures = checks.filter(([, ok]) => !ok).length;
console.log(
  `\n${failures === 0 && restored ? '✅ Parcours d’arrivée conforme.' : `❌ ${failures} contrôle(s) en défaut.`}`,
);
if (failures > 0 || !restored) process.exitCode = 1;

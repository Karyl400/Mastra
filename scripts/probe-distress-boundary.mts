/**
 * SONDE DE PRODUCTION — la frontière de la détresse : ce qui déclenche, et ce qui n'est pas gardé.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Ce qu'elle vérifie, et pourquoi aucun test unitaire ne peut le faire
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Deux propriétés livrées le 2026-08-22, toutes deux invisibles depuis la suite unitaire :
 *
 * 1. **« Je n'ai transmis ce message à personne : il reste entre nous » est VRAI.**
 *    `ingest()` tourne AVANT le court-circuit de `handleMessage` — ligne 1010 contre 1737 —
 *    donc le texte était écrit en base au moment même où le bot promettait le contraire, et
 *    il partait chez un fournisseur LLM tiers par le second rideau. La garde vit désormais
 *    dans `ingest()`. Seule une sonde qui LIT LA BASE DE PRODUCTION après avoir envoyé un
 *    vrai message signé peut le prouver.
 *
 * 2. **Un nom nu ne déclenche plus sur le vocabulaire de travail.** « je veux en finir avec
 *    ce ticket » recevait le message de prévention du suicide. Huit phrases de travail sur
 *    neuf déclenchaient.
 *
 * ⚠️ **LE CONTRÔLE POSITIF EST LA MOITIÉ DE CETTE SONDE.** Sans lui, une panne d'archivage
 * — table absente, `knowledgeIngestion` non câblé, Turso muet — ferait passer au vert les
 * contrôles de confidentialité : ils mesureraient leur propre panne et l'appelleraient une
 * garantie. Le cinquième contrôle envoie donc un message ORDINAIRE et exige qu'il SOIT
 * archivé. C'est ce même raisonnement qui a fait découvrir le faux positif de « en finir » :
 * la phrase neutre choisie pour prouver que l'archivage marchait déclenchait la détresse.
 *
 * ⚠️ **COÛT : UN SEUL APPEL DE MODÈLE**, celui du contrôle n° 4. Les quatre autres sont des
 * court-circuits déterministes ou des lectures de base. Le budget se compte à la journée.
 *
 * ⚠️ Elle poste de VRAIS messages dans le DM du bot. Ce n'est pas un dry-run : c'est le seul
 * moyen de vérifier la chaîne de bout en bout.
 *
 * Usage :
 *   npx tsx --env-file=.env scripts/probe-distress-boundary.mts [url] [--channel D…]
 *   npx tsx --env-file=.env scripts/probe-distress-boundary.mts --free   # sans le n° 4
 */
import { createHmac } from 'node:crypto';
import { createClient } from '@libsql/client';

import { AGGRESSION_REPLY, DISTRESS_REPLY, distressKind } from '../src/shared/distress';

const DEFAULT_URL = 'https://mastra-71ya.vercel.app';
const DEFAULT_CHANNEL = 'D0BM9MK9QJV';
const REQUESTER = 'U0BJBDGTJUD';

const args = process.argv.slice(2);
const baseUrl = (args.find((a) => a.startsWith('http')) ?? DEFAULT_URL).replace(/\/$/, '');
const channelArg = args.indexOf('--channel');
const channel = channelArg >= 0 ? args[channelArg + 1]! : DEFAULT_CHANNEL;
const freeOnly = args.includes('--free');

const signingSecret = process.env.SLACK_SIGNING_SECRET;
const botToken = process.env.SLACK_BOT_TOKEN;
if (!signingSecret) throw new Error('SLACK_SIGNING_SECRET manquant');
if (!botToken) throw new Error('SLACK_BOT_TOKEN manquant');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL manquant');

const db = createClient({
  url: process.env.DATABASE_URL,
  authToken: process.env.DATABASE_AUTH_TOKEN,
});

interface Case {
  readonly name: string;
  readonly text: string;
  /** `null` = aucune réponse figée attendue (le message part chez un agent). */
  readonly expectedReply: string | null;
  readonly mustBeArchived: boolean;
  readonly costsAModelCall: boolean;
}

const CASES: readonly Case[] = [
  {
    name: 'détresse nue — déclenche, et n’est PAS gardée',
    text: 'je veux en finir',
    expectedReply: DISTRESS_REPLY,
    mustBeArchived: false,
    costsAModelCall: false,
  },
  {
    name: 'agression — déclenche, et n’est PAS gardée',
    text: 'mon manager me harcèle depuis des semaines',
    expectedReply: AGGRESSION_REPLY,
    mustBeArchived: false,
    costsAModelCall: false,
  },
  {
    name: 'nom nu SEUL — déclenche encore (un mot n’a aucun contexte)',
    text: 'harcèlement',
    expectedReply: AGGRESSION_REPLY,
    mustBeArchived: false,
    costsAModelCall: false,
  },
  {
    name: 'tournure de travail — ne déclenche PLUS',
    text: 'je veux en finir avec ce ticket avant jeudi',
    expectedReply: null,
    mustBeArchived: true,
    costsAModelCall: true,
  },
  /**
   * ⚠️ LE CONTRÔLE POSITIF EST UNE SALUTATION, ET C'EST UN CHOIX MESURÉ.
   *
   * Il doit prouver que l'archivage FONCTIONNE, sinon les trois contrôles ci-dessus
   * mesureraient une panne et l'appelleraient une garantie. Mais il ne doit rien coûter :
   * une phrase ordinaire en DM part chez un agent. La salutation résout les deux — elle est
   * court-circuitée (zéro token) ET archivée, parce que `ingest()` tourne AVANT le
   * court-circuit. C'est exactement la propriété qui rendait la promesse de confidentialité
   * fausse ; on s'en sert ici pour prouver que la garde ne l'a pas éteinte pour tout le monde.
   */
  {
    name: 'CONTRÔLE POSITIF — une salutation EST bien archivée',
    text: 'bonjour',
    expectedReply: null,
    mustBeArchived: true,
    costsAModelCall: false,
  },
];

/**
 * ⚠️ TOUTE E/S RÉSEAU PASSE PAR ICI, ET C'EST UNE LEÇON DÉJÀ PAYÉE.
 *
 * `probe-arrival.mts` a été tué deux fois par un `UND_ERR_CONNECT_TIMEOUT` — une fois vers
 * Slack, une fois vers Turso — et la seconde a laissé la base de production sale. Cette sonde
 * a reproduit le même défaut à sa première exécution réelle, le 2026-08-22.
 *
 * Une sonde qui meurt d'un aléa réseau ne rend pas un verdict « échec » : elle ne rend AUCUN
 * verdict, et l'on est tenté de lire son silence comme un succès partiel.
 */
async function resilientFetch(url: string, init?: RequestInit, attempts = 4): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, attempt * 3_000));
    }
  }
  throw lastError;
}

let counter = 0;
const uniqueTs = (): string =>
  `${Math.floor(Date.now() / 1000)}.${String(counter++).padStart(6, '0')}`;

async function send(text: string, ts: string): Promise<number> {
  const body = JSON.stringify({
    type: 'event_callback',
    team_id: 'TMLKC4EPP',
    event_id: `EvDB${ts.replace('.', '')}`,
    event_time: Math.floor(Date.now() / 1000),
    event: { type: 'message', channel_type: 'im', user: REQUESTER, channel, text, ts },
  });

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature =
    'v0=' + createHmac('sha256', signingSecret!).update(`v0:${timestamp}:${body}`).digest('hex');

  const response = await resilientFetch(`${baseUrl}/slack/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signature,
    },
    body,
  });
  return response.status;
}

async function lastBotMessage(): Promise<string> {
  const response = await resilientFetch(
    `https://slack.com/api/conversations.history?channel=${channel}&limit=5`,
    { headers: { authorization: `Bearer ${botToken}` } },
  );
  const payload = (await response.json()) as { messages?: { text?: string; bot_id?: string }[] };
  const fromBot = (payload.messages ?? []).find((m) => m.bot_id);
  return fromBot?.text ?? '';
}

/**
 * ⚠️ LA REPRISE DOIT COUVRIR LA BASE AUSSI, et c'est la MÊME leçon payée deux fois le même
 * jour : la première version de cette sonde enveloppait ses appels HTTP et laissait la
 * requête Turso nue. Un `UND_ERR_CONNECT_TIMEOUT` vers `turso.io` l'a tuée au deuxième
 * contrôle. Le dépôt avait déjà écrit la phrase — « `resilientFetch` ne couvrait que
 * Slack » — et je l'ai reproduite.
 */
async function retry<T>(operation: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, attempt * 3_000));
    }
  }
  throw lastError;
}

async function isArchived(ts: string): Promise<boolean> {
  const rows = await retry(() =>
    db.execute({
      sql: 'SELECT 1 FROM channel_messages WHERE channel_id = ? AND id LIKE ? LIMIT 1',
      args: [channel, `%${ts}`],
    }),
  );
  return rows.rows.length > 0;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * ⚠️ 14 SECONDES ENTRE DEUX ENVOIS, ET CE N'EST PAS DU CONFORT. `BURST_RULE` plafonne à
 * 5 messages par minute et s'applique AUSSI aux court-circuits gratuits. Une sonde plus
 * rapide se fait refuser et désigne alors des causes imaginaires — le défaut exact trouvé
 * sur `probe-arrival.mts` le 2026-08-21.
 */
const CADENCE_MS = 14_000;

async function main(): Promise<void> {
  console.log(`Sonde de la frontière de détresse — ${baseUrl}, canal ${channel}\n`);

  const selected = CASES.filter((c) => !(freeOnly && c.costsAModelCall));
  let failures = 0;

  for (const [index, probe] of selected.entries()) {
    const ts = uniqueTs();

    // Le miroir local : ce que le CODE de cette machine pense, avant de demander à la prod.
    const localVerdict = distressKind(probe.text);
    const localExpectsReply = localVerdict !== null;
    const wantsReply = probe.expectedReply !== null;
    if (localExpectsReply !== wantsReply) {
      console.log(
        `⚠️  ${probe.name}\n    le code LOCAL et l'attente de la sonde divergent ` +
          `(local: ${String(localVerdict)}) — corriger la sonde ou le code avant de conclure.`,
      );
      failures += 1;
    }

    const status = await send(probe.text, ts);
    await sleep(probe.costsAModelCall ? 45_000 : 6_000);

    const posted = await lastBotMessage();
    const archived = await isArchived(ts);

    const replyOk = wantsReply ? posted.trim() === probe.expectedReply!.trim() : true;
    const archiveOk = archived === probe.mustBeArchived;
    const ok = status === 200 && replyOk && archiveOk;

    console.log(`${ok ? '✅' : '❌'} ${probe.name}`);
    console.log(`    HTTP ${status} · archivé: ${archived} (attendu ${probe.mustBeArchived})`);
    if (!replyOk) {
      console.log(`    réponse INATTENDUE : ${posted.slice(0, 120)}…`);
    }
    if (!ok) failures += 1;

    if (index < selected.length - 1) await sleep(CADENCE_MS);
  }

  console.log(
    `\n${failures === 0 ? '✅' : '❌'} ${selected.length - failures}/${selected.length} contrôles conformes`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();

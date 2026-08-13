/**
 * SONDE DE PRODUCTION — les quatre réponses déterministes, pour ZÉRO token.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Pourquoi cette sonde peut tourner en production sans rien coûter
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Le quota Groq se compte à la JOURNÉE (100 000 tokens ≈ 19 messages, tous canaux
 * confondus) : une campagne de test en production épuise le produit pour le reste de la
 * journée. C'est la contrainte qui a jusqu'ici rendu les vérifications en production si
 * chères.
 *
 * Les quatre chemins sondés ici sont précisément ceux qui **n'appellent aucun modèle** :
 * salutation, message sans contenu textuel, message trop long, détresse, pièce jointe. Leur
 * coût en tokens est nul, donc cette sonde est répétable autant de fois qu'on veut — et
 * c'est justement ce qui permet de la faire tourner APRÈS chaque déploiement.
 *
 * Ce qu'elle prouve, et qu'aucun test unitaire ne peut prouver : que le code déployé est
 * bien celui qu'on croit, que la signature passe, que `waitUntil` ne gèle pas la fonction
 * avant la publication, et que le message atteint réellement Slack.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Ce qu'elle écrit, et où
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ Elle poste de VRAIS messages dans la conversation directe entre le bot et la personne
 * ciblée. Ce n'est pas un dry-run : c'est le seul moyen de vérifier la livraison de bout en
 * bout. La cible par défaut est le DM du propriétaire du workspace.
 *
 * Les constantes attendues sont IMPORTÉES depuis les modules source, jamais recopiées : une
 * copie diverge au premier changement de rédaction et la sonde passerait au vert en
 * vérifiant un texte qui n'existe plus.
 *
 * Usage :
 *   npx tsx --env-file=.env scripts/probe-deterministic-replies.mts [url] [--channel D…]
 */
import { createHmac } from 'node:crypto';
import { GREETING_REPLY } from '../src/shared/greeting';
import { DISTRESS_REPLY } from '../src/shared/distress';
import { CONTENT_FREE_REPLY, TOO_LONG_REPLY } from '../src/shared/message-shape';
import { FILE_ATTACHMENT_REPLY } from '../src/features/notification/infrastructure/handlers/slack-events.handler';
import { MAX_USER_INPUT_LENGTH } from '../src/shared/security/llm-guardrail';

const DEFAULT_URL = 'https://mastra-71ya.vercel.app';
const DEFAULT_CHANNEL = 'D0BM9MK9QJV';
const REQUESTER = 'U0BJBDGTJUD';

const args = process.argv.slice(2);
const baseUrl = (args.find((a) => a.startsWith('http')) ?? DEFAULT_URL).replace(/\/$/, '');
const channelArg = args.indexOf('--channel');
const channel = channelArg >= 0 ? args[channelArg + 1] : DEFAULT_CHANNEL;

const signingSecret = process.env.SLACK_SIGNING_SECRET;
const botToken = process.env.SLACK_BOT_TOKEN;
if (!signingSecret) throw new Error('SLACK_SIGNING_SECRET manquant');
if (!botToken) throw new Error('SLACK_BOT_TOKEN manquant');

interface Probe {
  readonly name: string;
  readonly text: string;
  readonly subtype?: string;
  readonly expected: string;
}

const PROBES: readonly Probe[] = [
  { name: 'salutation nue', text: 'bonjour', expected: GREETING_REPLY },
  { name: 'sans contenu textuel', text: '🎉🎉', expected: CONTENT_FREE_REPLY },
  {
    name: 'trop long',
    // Un seul caractère au-delà de la borne : on sonde la DÉCISION, pas un ordre de grandeur.
    text: 'a'.repeat(MAX_USER_INPUT_LENGTH + 1),
    expected: TOO_LONG_REPLY,
  },
  {
    name: 'détresse',
    text: "je t'écris parce que je ne vais pas bien",
    expected: DISTRESS_REPLY,
  },
  {
    name: 'pièce jointe',
    text: '',
    subtype: 'file_share',
    expected: FILE_ATTACHMENT_REPLY,
  },
];

/**
 * Horodatage unique par sonde. C'est la clé de DÉDUPLICATION du handler
 * (`ts:<channel>:<ts>`), partagée entre instances via Turso : deux sondes qui la
 * partageraient verraient la seconde silencieusement écartée, et l'on conclurait à tort que
 * le chemin ne répond pas.
 */
let counter = 0;
const uniqueTs = (): string => `${Math.floor(Date.now() / 1000)}.${String(counter++).padStart(6, '0')}`;

async function send(probe: Probe): Promise<{ status: number; ts: string; ms: number }> {
  const ts = uniqueTs();
  const body = JSON.stringify({
    type: 'event_callback',
    team_id: 'TMLKC4EPP',
    event_id: `EvPROBE${ts.replace('.', '')}`,
    event_time: Math.floor(Date.now() / 1000),
    event: {
      type: 'message',
      channel_type: 'im',
      user: REQUESTER,
      channel,
      text: probe.text,
      ts,
      ...(probe.subtype ? { subtype: probe.subtype } : {}),
    },
  });

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature =
    'v0=' + createHmac('sha256', signingSecret!).update(`v0:${timestamp}:${body}`).digest('hex');

  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/slack/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signature,
    },
    body,
  });
  await response.text();
  return { status: response.status, ts, ms: Date.now() - startedAt };
}

/** Messages postés par le BOT depuis un instant donné, les plus récents d'abord. */
async function botMessagesSince(oldest: number): Promise<string[]> {
  const url = `https://slack.com/api/conversations.history?channel=${channel}&oldest=${oldest}&limit=50`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${botToken}` } });
  const payload = (await response.json()) as {
    ok: boolean;
    error?: string;
    messages?: Array<{ text?: string; bot_id?: string }>;
  };
  if (!payload.ok) throw new Error(`conversations.history a échoué : ${payload.error}`);
  return (payload.messages ?? []).filter((m) => m.bot_id).map((m) => m.text ?? '');
}

const startedAt = Math.floor(Date.now() / 1000) - 1;

console.log(`Cible   : ${baseUrl}/slack/events`);
console.log(`Canal   : ${channel}\n`);

// SÉQUENTIEL, avec une pause. Le limiteur de débit écarte les rafales (5 messages/minute par
// défaut) : envoyer les cinq sondes d'un coup ferait refuser les dernières, et l'on
// conclurait à tort que le chemin est cassé.
for (const probe of PROBES) {
  const { status, ms } = await send(probe);
  console.log(`→ ${probe.name.padEnd(22)} ACK ${status} en ${String(ms).padStart(5)} ms`);
  await new Promise((resolve) => setTimeout(resolve, 14_000));
}

console.log('\nLecture des réponses réellement postées dans Slack…\n');
await new Promise((resolve) => setTimeout(resolve, 5_000));
const posted = await botMessagesSince(startedAt);

let failures = 0;
for (const probe of PROBES) {
  const found = posted.some((text) => text.trim() === probe.expected.trim());
  console.log(`${found ? '✅' : '❌'} ${probe.name}`);
  if (!found) {
    failures += 1;
    console.log(`   attendu : ${probe.expected.slice(0, 90)}…`);
  }
}

console.log(`\n${posted.length} message(s) du bot relevé(s) dans la fenêtre.`);
if (failures > 0) {
  console.error(`\n❌ ${failures} sonde(s) sans réponse conforme.`);
  process.exit(1);
}
console.log('\n✅ Les cinq réponses déterministes sont conformes, pour zéro token consommé.');

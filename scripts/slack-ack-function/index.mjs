/**
 * ════════════════════════════════════════════════════════════════════════════
 * LE PORTIER SLACK — une fonction SANS AUCUNE DÉPENDANCE, dont le seul travail
 * est de dire « 200 » à Slack dans le temps qu'il accorde.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ## Le défaut qu'il corrige, mesuré et non supposé
 *
 * Le 2026-08-19, un clic de bouton SIGNÉ sur `/slack/interactions` en production :
 *   • instance froide : **5 229 ms**, puis 9 173 ms sur un déploiement neuf ;
 *   • instance chaude : **684 ms**.
 * Le handler ACK pourtant sans la moindre E/S. L'import du graphe applicatif ne prend que
 * **0,82 s** en local : le reste est le téléchargement et le DÉPAQUETAGE de la fonction
 * (264 Mo, 20 447 fichiers avant élagage).
 *
 * Slack accorde **3 secondes** à une interaction. Le budget était donc épuisé AVANT la
 * première instruction — c'est la cause unique et suffisante des « boutons qui ne marchent
 * pas », et aucune optimisation du handler ne pouvait l'atteindre. Le trafic étant de ≈ 19
 * messages par jour, presque chaque clic tombe sur une instance froide : l'exception est le
 * cas nominal.
 *
 * ## Pourquoi une SECONDE fonction, et pas un handler plus léger
 *
 * Parce que le coût n'est pas dans le code exécuté mais dans ce qu'il faut dépaqueter avant
 * de l'exécuter. Tant que l'ACK vit dans la même fonction que Mastra, les agents, le SDK IA,
 * `pdfmake` et `docx`, il paie leur poids. L'élagage l'a réduit de 264 à 160 Mo — utile, mais
 * une amélioration n'est pas une garantie, et le seuil de 3 s est un seuil, pas une moyenne.
 *
 * Ce fichier n'importe QUE `node:crypto`. Il n'a pas de `node_modules`. Son démarrage à froid
 * est celui de Node lui-même.
 *
 * ## Ce qu'il ne fait PAS, et pourquoi c'est important
 *
 * Il ne décide rien. Il ne lit aucune base, n'appelle pas Slack, ne connaît aucun `action_id`.
 * Il vérifie la signature, répond, et REJOUE la requête telle quelle vers la fonction
 * applicative, en-têtes compris. Toute la logique reste à un seul endroit.
 *
 * ⚠️ La signature est vérifiée DEUX fois : ici, et de nouveau par la route applicative sur le
 * corps réexpédié à l'identique. Ce n'est pas une redondance inutile — le contrôle d'ici évite
 * de nous faire réexpédier n'importe quoi (une amplification offerte à quiconque connaît
 * l'URL), et celui de là-bas reste la vraie frontière, inchangée, y compris si ce portier
 * disparaît un jour du routage.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Fenêtre de fraîcheur Slack : au-delà, un rejeu est refusé. Identique à la route applicative. */
const MAX_TIMESTAMP_SKEW_SECONDS = 300;

/** Là où la requête est REJOUÉE. Voir `slack-events.route.ts` pour l'alias correspondant. */
const WORK_PREFIX = '/internal';

/**
 * Comparaison à temps constant, y compris sur des longueurs différentes.
 *
 * `timingSafeEqual` LÈVE si les tampons n'ont pas la même taille : comparer les longueurs
 * d'abord réintroduirait la fuite qu'on cherche à éviter, en la déplaçant.
 */
function safeEqual(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Prolonge l'invocation au-delà de la réponse.
 *
 * Même mécanisme que `scheduleBackgroundWork` dans `slack-events.route.ts` : sans lui, Vercel
 * gèle la fonction dès la réponse envoyée et le réacheminement ne partirait jamais. Absent
 * hors Vercel, où le détachement simple suffit.
 */
function keepAlive(promise) {
  const context = globalThis[Symbol.for('@vercel/request-context')]?.get?.();
  if (typeof context?.waitUntil === 'function') {
    context.waitUntil(promise);
    return 'vercel-wait-until';
  }
  return 'detached';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end();
    return;
  }

  const rawBody = await readRawBody(req);
  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];
  const secret = process.env.SLACK_SIGNING_SECRET;

  if (!secret || !timestamp || !signature) {
    res.statusCode = 401;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'unauthorized', reason: 'missing_signature_headers' }));
    return;
  }

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > MAX_TIMESTAMP_SKEW_SECONDS) {
    res.statusCode = 401;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'unauthorized', reason: 'stale_timestamp' }));
    return;
  }

  const expected = 'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex');
  if (!safeEqual(expected, String(signature))) {
    res.statusCode = 401;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'unauthorized', reason: 'signature_mismatch' }));
    return;
  }

  // ⚠️ `url_verification` est répondu ICI, jamais réexpédié : Slack attend le `challenge` DANS
  // la réponse. Le réacheminer produirait un 200 vide, et l'URL serait refusée — c'est-à-dire
  // la fonctionnalité entière qui n'existe jamais.
  if (req.url?.includes('/events')) {
    try {
      const parsed = JSON.parse(rawBody);
      if (parsed?.type === 'url_verification') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ challenge: parsed.challenge }));
        return;
      }
    } catch {
      // Un corps illisible n'est pas notre affaire : la route applicative sait le refuser
      // avec le bon code. On réexpédie.
    }
  }

  const target = req.url?.includes('/interactions')
    ? `${WORK_PREFIX}/slack/interactions`
    : `${WORK_PREFIX}/slack/events`;

  // ⚠️ L'hôte vient de la REQUÊTE, jamais d'une variable : sur un déploiement de
  // prévisualisation, une URL de production ferait traiter l'événement par le mauvais code —
  // et le symptôme serait « ça marche », avec l'ancien comportement.
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  const url = `https://${host}${target}`;

  const forwarded = fetch(url, {
    method: 'POST',
    headers: {
      'content-type': req.headers['content-type'] ?? 'application/json',
      'x-slack-request-timestamp': String(timestamp),
      'x-slack-signature': String(signature),
      ...(req.headers['x-slack-retry-num']
        ? { 'x-slack-retry-num': String(req.headers['x-slack-retry-num']) }
        : {}),
      ...(req.headers['x-slack-retry-reason']
        ? { 'x-slack-retry-reason': String(req.headers['x-slack-retry-reason']) }
        : {}),
    },
    body: rawBody,
  }).catch((error) => {
    // Journal en clair : c'est la SEULE trace si le réacheminement casse, et le symptôme côté
    // utilisateur serait un bot parfaitement muet avec des ACK impeccables.
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'Slack ack gateway: forwarding failed',
        data: { target, error: String(error) },
      })
    );
  });

  const mode = keepAlive(forwarded);
  if (mode === 'detached') {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'Slack ack gateway: work is detached (waitUntil unavailable)',
        data: { target },
      })
    );
  }

  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true }));
}

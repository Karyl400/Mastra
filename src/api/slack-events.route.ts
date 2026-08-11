/**
 * Route HTTP de l'Events API Slack — implémentation CANONIQUE.
 *
 * ⚠️ Un fichier posé dans `src/api/` n'est PAS monté automatiquement par Mastra.
 * Cette route n'existe que parce que `slackEventsRoute` est passé à
 * `server.apiRoutes` dans `src/mastra/index.ts`.
 *
 * ⚠️ CHEMIN : les chemins personnalisés ne peuvent PAS commencer par l'`apiPrefix`
 * du serveur (par défaut `/api`) — `@mastra/server` lève au démarrage :
 *   `Custom API route "/api/slack-events" must not start with "/api" — that path is
 *    reserved for built-in Mastra routes.`
 * (Vérifié empiriquement contre @mastra/deployer `createHonoServer`.)
 * On monte donc sur `/slack/events`, et c'est CETTE URL qui doit être renseignée dans
 * le champ « Request URL » de l'app Slack :
 *   https://<domaine>/slack/events
 * (L'alternative — `apiPrefix: '/mastra/api'` pour libérer `/api` — déplacerait toutes
 * les routes internes Mastra et le playground : rejetée, trop risquée.)
 */
import { registerApiRoute } from '@mastra/core/server';
import type { Mastra } from '@mastra/core';

import {
  SlackEventsHandler,
  type SlackEventEnvelope,
} from '../features/notification/infrastructure/handlers/slack-events.handler';
import { verifySlackSignature } from '../shared/security/slack-signature';
import { logger } from '../shared/logger';

/** Chemin public de l'endpoint Slack. À reporter tel quel dans l'app Slack. */
export const SLACK_EVENTS_PATH = '/slack/events';

/* ------------------------------------------------------------------------- *
 * Prolongation de vie de la fonction serverless (`waitUntil`)
 * ------------------------------------------------------------------------- */

/**
 * Clé du contexte de requête posée par le lanceur Vercel sur `globalThis`.
 * C'est le SEUL et unique contrat de `waitUntil` : `@vercel/functions@3.8.0`
 * (`wait-until.js` + `get-context.js`) se réduit littéralement à
 * `globalThis[Symbol.for('@vercel/request-context')]?.get?.()?.waitUntil?.(promise)`.
 *
 * On le lit en direct plutôt que d'ajouter la dépendance `@vercel/functions` :
 *  - le bundler de `@mastra/deployer-vercel` fait sa propre analyse de dépendances puis
 *    recopie `node_modules` dans `.vercel/output/functions/index.func/` — un mécanisme qui
 *    a déjà dû être rattrapé à la main (`scripts/fix-vercel-output.js`) ;
 *  - `@vercel/functions` tire `@vercel/oidc` et des peers AWS SDK pour six lignes de code.
 * Zéro dépendance = zéro risque de bundling, pour exactement le même comportement.
 *
 * ⚠️ `hono/vercel` ne peut PAS servir de solution de repli :
 * `node_modules/hono/dist/adapter/vercel/handler.js` est `handle = (app) => (req) =>
 * app.fetch(req)` — l'`ExecutionContext` n'est jamais transmis, donc `c.executionCtx`
 * lève « This context has no ExecutionContext ». C'est bien ce `handle()` qu'utilise
 * l'entrée générée par le déployeur (`VercelDeployer.getEntry()`).
 */
const VERCEL_REQUEST_CONTEXT = Symbol.for('@vercel/request-context');

interface VercelRequestContext {
  waitUntil?: (promise: Promise<unknown>) => void;
}

type VercelRequestContextHolder = {
  [VERCEL_REQUEST_CONTEXT]?: { get?: () => VercelRequestContext | undefined };
};

/** Mécanisme effectivement retenu pour faire vivre le traitement de fond. */
export type BackgroundMechanism = 'vercel-wait-until' | 'detached';

/** `waitUntil` du lanceur Vercel, ou `undefined` hors Vercel (dev local, tests). */
export function getVercelWaitUntil(): ((promise: Promise<unknown>) => void) | undefined {
  const holder = globalThis as typeof globalThis & VercelRequestContextHolder;
  const context = holder[VERCEL_REQUEST_CONTEXT]?.get?.();
  return typeof context?.waitUntil === 'function' ? context.waitUntil.bind(context) : undefined;
}

/**
 * Planifie un travail qui doit survivre à l'envoi de la réponse HTTP.
 *
 * Sur Vercel, `waitUntil` empêche le gel de la fonction tant que la promesse n'est pas
 * réglée (dans la limite du `maxDuration`). Hors Vercel — `mastra dev`, tests, tout
 * serveur Node de longue durée — le simple détachement suffit puisque le processus vit.
 *
 * La promesse reçue DOIT déjà être « catchée » : `waitUntil` propagerait sinon un rejet
 * non géré.
 */
export function scheduleBackgroundWork(work: Promise<unknown>): BackgroundMechanism {
  const waitUntil = getVercelWaitUntil();
  if (waitUntil) {
    waitUntil(work);
    return 'vercel-wait-until';
  }
  return 'detached';
}

/**
 * Sous-ensemble du `Context` Hono réellement utilisé par la route.
 * Permet de tester le handler sans démarrer un serveur.
 */
export interface SlackRouteContext {
  req: {
    text(): Promise<string>;
    header(name: string): string | undefined;
  };
  get(key: 'mastra'): Mastra;
  json(body: unknown, status?: number): Response;
}

/**
 * Handler mémorisé : le cache de déduplication et le `bot_user_id` résolu via
 * `auth.test()` doivent survivre entre deux requêtes.
 */
let cachedHandler: SlackEventsHandler | undefined;
let cachedMastra: Mastra | undefined;

export function getSlackEventsHandler(mastra: Mastra): SlackEventsHandler {
  if (!cachedHandler || cachedMastra !== mastra) {
    cachedHandler = new SlackEventsHandler(process.env.SLACK_BOT_TOKEN ?? '', mastra);
    cachedMastra = mastra;
  }
  return cachedHandler;
}

/** Réinitialise le singleton (tests). */
export function resetSlackEventsHandler(): void {
  cachedHandler = undefined;
  cachedMastra = undefined;
}

export async function handleSlackEventRequest(c: SlackRouteContext): Promise<Response> {
  // 1. Corps BRUT obligatoire pour le HMAC. Parser puis re-sérialiser casserait la
  //    signature (espaces / ordre des clés).
  const rawBody = await c.req.text();

  const verification = verifySlackSignature({
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    timestamp: c.req.header('x-slack-request-timestamp'),
    signature: c.req.header('x-slack-signature'),
    rawBody,
  });

  if (!verification.valid) {
    // `url_verification` est signé lui aussi : la vérification s'applique à TOUS les
    // types d'événements, sans exception.
    logger.warn('Rejected Slack request', { reason: verification.reason });
    return c.json({ error: 'unauthorized', reason: verification.reason }, 401);
  }

  let body: SlackEventEnvelope;
  try {
    body = JSON.parse(rawBody) as SlackEventEnvelope;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  // 2. Handshake Slack (envoyé AVANT que l'app soit vérifiée, mais bien signé).
  if (body.type === 'url_verification') {
    logger.info('Handling Slack URL verification');
    return c.json({ challenge: body.challenge ?? '' });
  }

  const handler = getSlackEventsHandler(c.get('mastra'));

  // 3. Filtrage + déduplication SYNCHRONES, avant l'ACK, pour qu'un renvoi Slack ne
  //    déclenche pas un second traitement de fond.
  const retryNum = c.req.header('x-slack-retry-num');
  const decision = handler.accept(body, { retryNum });

  if (decision.action === 'process') {
    // 4. Slack renvoie tout événement non accusé en moins de 3 s, et un appel agent
    //    prend 2 à 17 s (cf. TEST_REPORT.md) → traitement en tâche de fond.
    //
    //    ⚠️ SERVERLESS (Vercel) : un simple `void promise` ne suffit PAS. La fonction est
    //    gelée dès la réponse envoyée et l'appel LLM en vol est tué — symptôme observé en
    //    production : ACK 200, aucune réponse dans Slack, et AUCUN log après l'ACK.
    //    `waitUntil()` déclare la promesse au lanceur Vercel, qui maintient l'instance
    //    éveillée jusqu'à son règlement (borné par `maxDuration`).
    const work = handler.handleEvent(body).catch((error) => {
      logger.error('Background Slack event processing failed', {
        error,
        eventId: body.event_id,
        eventType: body.event?.type,
      });
    });

    const mechanism = scheduleBackgroundWork(work);

    // `retryNum` n'était journalisé QUE sur le chemin dupliqué. Sur le chemin
    // accepté, l'en-tête était lu puis jeté — impossible de distinguer un rejeu
    // Slack d'un événement jumeau (`message` + `app_mention`) quand deux
    // réponses partent pour un seul message. C'est la ligne qui tranche.
    logger.info('Slack event scheduled', {
      mechanism,
      eventId: body.event_id,
      eventType: body.event?.type,
      retryNum: retryNum ?? null,
    });

    // Garde-fou d'observabilité : sur Vercel, `detached` signifie que le travail SERA
    // tué au gel de la fonction. C'est la ligne à chercher dans les logs si le bot
    // recommence à ne plus répondre.
    if (mechanism === 'detached' && process.env.VERCEL) {
      logger.error('Slack background work is detached on Vercel — waitUntil unavailable', {
        eventId: body.event_id,
      });
    }
  } else {
    logger.debug('Slack event ignored', { reason: decision.reason, eventId: body.event_id });
  }

  // 5. ACK immédiat — toujours 200, sinon Slack rejoue puis désactive l'endpoint.
  return c.json({ ok: true });
}

export const slackEventsRoute = registerApiRoute(SLACK_EVENTS_PATH, {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: 'Slack Events API webhook',
    description:
      'Reçoit les événements Slack (url_verification, app_mention, message.im). ' +
      'Signature HMAC-SHA256 vérifiée, ACK immédiat, traitement agent en tâche de fond.',
    tags: ['slack'],
    responses: {
      200: { description: 'Événement accusé réception' },
      400: { description: 'Corps JSON invalide' },
      401: { description: 'Signature Slack invalide, absente ou expirée' },
    },
  },
  handler: async (c) => handleSlackEventRequest(c as unknown as SlackRouteContext),
});

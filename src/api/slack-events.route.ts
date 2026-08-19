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
  type SlackEventsHandlerOptions,
} from '../features/notification/infrastructure/handlers/slack-events.handler';
import { verifySlackSignature } from '../shared/security/slack-signature';
import { logger } from '../shared/logger';
import { SlackWorkspaceService } from '../features/notification/infrastructure/providers/slack-workspace.service';
import { makeWelcomeChannels } from '../features/directory/application/services/welcome-channels.service';
import { SlackWelcomeChannelSource } from '../features/directory/infrastructure/providers/slack-welcome-channel.adapter';
import { parseWelcomeChannelNames } from '../features/directory/domain/services/welcome-channel-names';
import { DrizzleOnboardingInterviewRepository } from '../features/onboarding/infrastructure/repositories/drizzle-onboarding-interview.repository';
import { DrizzleEmployeeRepository } from '../features/employee/infrastructure/repositories/drizzle-employee.repository';

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

/* ------------------------------------------------------------------------- *
 * Budget d'ACK Slack — instrumentation
 * ------------------------------------------------------------------------- */

/**
 * Slack rejoue tout événement qu'il n'a pas vu accusé dans ce délai. Ce n'est pas une
 * recommandation : c'est le mécanisme qui a produit la DOUBLE RÉPONSE du 2026-08-11 12:38 UTC.
 * Un ACK à 6,7 s sur démarrage à froid a déclenché un rejeu (`retryNum: 1`) routé vers une
 * instance NEUVE, au cache vide, qui a répondu une seconde fois avec un texte différent.
 */
export const SLACK_ACK_BUDGET_MS = 3_000;

/**
 * Seuil d'alerte, à la moitié du budget.
 *
 * Il existe parce que le dépassement, lui, n'est PAS observable depuis la fonction : quand
 * l'ACK part à 3,4 s, on voit un `200` parfaitement normal dans les logs et un doublon
 * inexplicable dans Slack. La seule trace exploitable de l'incident du 2026-08-11 a été
 * reconstruite après coup, par déduction, à partir de deux messages contradictoires postés
 * dans un fil. Mesurer le chemin pré-ACK est ce qui manquait pour le voir venir.
 */
export const SLACK_ACK_AT_RISK_MS = 1_500;

/** État NOMMÉ du budget d'ACK — aucune dégradation de ce chemin ne doit être muette. */
export type AckBudgetState = 'ok' | 'at_risk' | 'exceeded';

export function classifyAckLatency(elapsedMs: number): AckBudgetState {
  if (elapsedMs >= SLACK_ACK_BUDGET_MS) return 'exceeded';
  if (elapsedMs >= SLACK_ACK_AT_RISK_MS) return 'at_risk';
  return 'ok';
}

/**
 * Journalise le coût du chemin pré-ACK, et seulement quand il devient intéressant.
 *
 * `exceeded` part en `error` et non en `warn` : à ce stade Slack a déjà rejoué, donc un second
 * traitement est déjà en vol quelque part. C'est la ligne à chercher quand une double réponse
 * réapparaît — avant d'aller soupçonner la déduplication, qui n'est que la victime.
 */
function reportAckBudget(state: AckBudgetState, details: Record<string, unknown>): void {
  if (state === 'exceeded') {
    logger.error('Slack ACK budget exceeded — Slack has already replayed this event', details);
  } else if (state === 'at_risk') {
    logger.warn('Slack ACK budget at risk', details);
  }
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

/**
 * COUTURE D'INJECTION RÉSERVÉE AUX TESTS — `undefined` en production, toujours.
 *
 * La route construit le handler par la voie de production, donc SANS options : le handler
 * construit alors PARESSEUSEMENT un `DrizzleRateLimitRepository`, un
 * `DrizzleSlackEventDedupRepository`, un `DrizzleConversationRepository` et un
 * `DrizzleDirectoryRepository`. C'est le bon comportement en production, et un piège en test
 * unitaire : `vitest.config.ts` ne charge pas `.env`, donc `DATABASE_URL` est absent et
 * `connection.ts` retombe sur `file:./data/kisso.db` — la VRAIE base de développement.
 *
 * Le mode d'échec est déjà arrivé : les compteurs de débit et les clés de déduplication y sont
 * alors PERSISTÉS, partagés entre tous les tests du fichier ET d'un run à l'autre. Passé le
 * 5ᵉ événement d'un même auteur (rafale par défaut de `rate-limit-policy.ts`), `accept()` rend
 * `rate_limited` et plus aucun travail de fond n'est programmé. La suite ne passait que parce
 * que ces tables étaient ABSENTES de la base locale — un test vert par absence de table n'est
 * pas un test vert, et `npm run db:init` suffisait à le casser.
 *
 * Cette couture ne change RIEN à la voie de production : sans appel explicite, les options
 * restent `undefined` et le constructeur reçoit exactement ce qu'il recevait avant.
 */
let handlerOptionsForTests: SlackEventsHandlerOptions | undefined;

/**
 * Invitation des arrivants aux canaux d'accueil, câblée ICI et non dans `src/mastra/index.ts`.
 *
 * ⚠️ Ce n'est pas une entorse à la règle « le câblage vit dans `index.ts` » mais sa
 * conséquence : `index.ts` importe cette route (`apiRoutes: [slackEventsRoute]`), donc
 * l'importer en retour créerait un cycle ESM — panne d'initialisation classique en bundle,
 * et le motif exact pour lequel `chatProvider` est déjà injecté par options plutôt que repris
 * d'`index.ts`.
 *
 * ZÉRO E/S à la construction : `parseWelcomeChannelNames` lit une variable d'environnement et
 * l'adaptateur ne fait qu'envelopper un client. Ce fichier est évalué à chaque démarrage à
 * froid, donc SUR le chemin des 3 secondes d'ACK — un ACK à 6,7 s a déjà provoqué un rejeu,
 * donc la double réponse du 2026-08-11. Le premier appel réseau n'a lieu qu'au premier
 * `team_join`.
 */
function buildWelcomeChannels(botToken: string) {
  return makeWelcomeChannels({
    source: new SlackWelcomeChannelSource(new SlackWorkspaceService(botToken)),
    channelNames: parseWelcomeChannelNames(process.env.ONBOARDING_WELCOME_CHANNELS),
  });
}

export function getSlackEventsHandler(mastra: Mastra): SlackEventsHandler {
  if (!cachedHandler || cachedMastra !== mastra) {
    const botToken = process.env.SLACK_BOT_TOKEN ?? '';
    cachedHandler = new SlackEventsHandler(botToken, mastra, {
      welcomeChannels: buildWelcomeChannels(botToken),
      // ⚠️ Injecté ICI et nulle part ailleurs : le handler n'a délibérément AUCUN repli
      // paresseux vers Drizzle pour ce dépôt. Un repli ferait que tout handler construit en
      // test toucherait la base — le piège qui a rendu onze tests d'`accept()` `rate_limited`
      // le jour où `rate_limit_counters` a existé. Absent, l'entretien conversationnel
      // collecte et répond correctement, seule la trace manque.
      interviewRepository: new DrizzleOnboardingInterviewRepository(),
      // ⚠️ Le MÊME dépôt que celui de la route d'interactivité, et c'est voulu : le bouton
      // « C'est fait » et la phrase « j'ai fini » doivent rendre le même verdict. Deux
      // sources de vérité pour une seule vérification finiraient par ne plus dire la même
      // chose — la divergence corrigée deux fois en un jour sur ce même parcours.
      profileRepository: new DrizzleEmployeeRepository(),
      // Les options de test l'emportent : un test qui neutralise les canaux doit pouvoir le
      // faire, et l'ordre inverse rendrait l'injection silencieusement inopérante.
      ...handlerOptionsForTests,
    });
    cachedMastra = mastra;
  }
  return cachedHandler;
}

/**
 * Installe les dépendances du handler construit par la route (tests uniquement).
 *
 * Invalide le singleton au passage : sans cela, un handler déjà mémorisé — donc déjà porteur
 * de ses dépôts Drizzle — survivrait à l'injection et la rendrait silencieusement inopérante.
 */
export function setSlackEventsHandlerOptionsForTests(
  options: SlackEventsHandlerOptions | undefined,
): void {
  handlerOptionsForTests = options;
  cachedHandler = undefined;
  cachedMastra = undefined;
}

/** Réinitialise le singleton ET l'injection de test — remise à l'état de production. */
export function resetSlackEventsHandler(): void {
  cachedHandler = undefined;
  cachedMastra = undefined;
  handlerOptionsForTests = undefined;
}

export async function handleSlackEventRequest(c: SlackRouteContext): Promise<Response> {
  // Horloge du budget d'ACK. Prise AVANT toute lecture : le corps de la requête, la
  // vérification HMAC et l'admission comptent tous dans les 3 s que Slack accorde.
  const startedAt = Date.now();

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

  // `accept()` est asynchrone depuis la déduplication partagée : la prise de clé fait un
  // aller-retour vers Turso, et le contrôle de débit un second (les deux règles y partent
  // désormais ENSEMBLE — cf. `SlackRateLimiter.check`). Il reste AVANT l'ACK, et c'est
  // délibéré : les deux décisions qu'il prend gouvernent l'existence même du travail de fond.
  // Les déplacer après l'ACK reviendrait à programmer d'abord et à décider ensuite — sur une
  // plateforme où « programmer » veut dire tenir la fonction éveillée et où le premier geste
  // du traitement est de poster un marqueur de progression dans Slack. Un rejeu écarté APRÈS
  // avoir posté « Je regarde ça, un instant… » n'est plus un rejeu écarté : c'est la double
  // réponse qu'on cherche à empêcher, avec une étape de plus.
  const admissionStartedAt = Date.now();
  const decision = await handler.accept(body, { retryNum });
  const admissionMs = Date.now() - admissionStartedAt;

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
  //    Le coût réel du chemin qui précède est mesuré et NOMMÉ : c'est le seul endroit d'où
  //    l'on puisse constater qu'on s'approche des 3 s, et l'instrument qui manquait le
  //    2026-08-11.
  const ackMs = Date.now() - startedAt;
  reportAckBudget(classifyAckLatency(ackMs), {
    ackMs,
    admissionMs,
    eventId: body.event_id,
    eventType: body.event?.type,
    action: decision.action,
    retryNum: retryNum ?? null,
  });

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

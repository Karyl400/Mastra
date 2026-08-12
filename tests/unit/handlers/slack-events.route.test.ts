import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mastra } from '@mastra/core';

// Aucun test unitaire ne doit toucher l'API Slack réelle.
const { postMessage, updateMessage, authTest } = vi.hoisted(() => ({
  // Le `ts` est indispensable : sans lui, le marqueur de progression est considéré comme
  // non posté et la réponse finale part en message SÉPARÉ au lieu de le remplacer.
  postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1700000000.000900' }),
  updateMessage: vi.fn().mockResolvedValue({ ok: true }),
  authTest: vi.fn().mockResolvedValue({ ok: true, user_id: 'U0BMBEJTBMJ' }),
}));

vi.mock('@slack/web-api', () => ({
  WebClient: class FakeWebClient {
    auth = { test: authTest };
    chat = { postMessage, update: updateMessage };
  },
}));

// La piste d'audit est le DERNIER accès base du chemin traité : `writeAuditLog` est une
// fonction de module, pas une dépendance injectable, donc aucune option du handler ne la
// neutralise. Sans cette doublure, chaque événement accepté écrit une ligne dans la VRAIE
// `data/kisso.db` (elle en porte déjà plus d'un millier, laissées là par les tests).
// Elle n'avale jamais ses erreurs ici : ces tests n'observent pas l'audit, ils observent
// seulement qu'on n'y touche pas.
vi.mock('../../../src/infrastructure/audit/audit-log', () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}));

import {
  slackEventsRoute,
  SLACK_EVENTS_PATH,
  resetSlackEventsHandler,
  setSlackEventsHandlerOptionsForTests,
  handleSlackEventRequest,
  scheduleBackgroundWork,
  getVercelWaitUntil,
  classifyAckLatency,
  SLACK_ACK_BUDGET_MS,
  SLACK_ACK_AT_RISK_MS,
  type SlackRouteContext,
} from '../../../src/api/slack-events.route';
import { computeSlackSignature } from '../../../src/shared/security/slack-signature';
import { PROGRESS_MARKER_TEXT } from '../../../src/features/notification/infrastructure/providers/slack-progress';
import { InMemorySlackEventDedupRepository } from '../../../src/features/notification/infrastructure/repositories/in-memory-slack-event-dedup.repository';

const SECRET = 'unit-test-signing-secret';
const BOT_USER_ID = 'U0BMBEJTBMJ';

/** Contexte Hono minimal suffisant pour la route (c.req.text/header, c.get, c.json). */
function makeContext(rawBody: string, headers: Record<string, string>, mastra: Mastra) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    req: {
      text: async () => rawBody,
      header: (name: string) => lower[name.toLowerCase()],
    },
    get: (key: string) => (key === 'mastra' ? mastra : undefined),
    json: (body: unknown, status = 200) => ({ body, status }),
  };
}

function makeMastra(generatedText = 'ok') {
  const generate = vi.fn().mockResolvedValue({ text: generatedText });
  const getAgent = vi.fn().mockReturnValue({ generate });
  return { mastra: { getAgent } as unknown as Mastra, getAgent, generate };
}

type RouteResult = { body: Record<string, unknown>; status: number };

async function callRoute(
  payload: unknown,
  options: {
    mastra?: Mastra;
    signature?: string;
    timestamp?: string;
    retryNum?: string;
    secret?: string | undefined;
  } = {},
): Promise<RouteResult> {
  const rawBody = JSON.stringify(payload);
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature =
    options.signature ?? computeSlackSignature(options.secret ?? SECRET, timestamp, rawBody);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-slack-request-timestamp': timestamp,
    'x-slack-signature': signature,
  };
  if (options.retryNum) headers['x-slack-retry-num'] = options.retryNum;

  const mastra = options.mastra ?? makeMastra().mastra;
  return invokeRoute(makeContext(rawBody, headers, mastra));
}

function invokeRoute(context: ReturnType<typeof makeContext>): Promise<RouteResult> {
  return handleSlackEventRequest(
    context as unknown as SlackRouteContext,
  ) as unknown as Promise<RouteResult>;
}

function eventCallback(event: Record<string, unknown>, eventId: string) {
  return { type: 'event_callback', team_id: 'TMLKC4EPP', event_id: eventId, event };
}

const dmEvent = (overrides: Record<string, unknown> = {}) => ({
  type: 'message',
  user: 'U000HUMAN01',
  // Volontairement PAS une salutation nue : celles-ci reçoivent une réponse
  // déterministe, sans appel LLM, depuis le 2026-08-12 (`src/shared/greeting.ts`).
  text: 'où en est mon dossier ?',
  channel: 'D0MOCKDM01',
  channel_type: 'im',
  ts: '1700000000.000200',
  ...overrides,
});

/**
 * Réinitialise le singleton de route ET réinstalle des dépendances HERMÉTIQUES.
 *
 * À appeler dans le `beforeEach` de CHAQUE bloc qui traverse la route : la voie de production
 * construit le handler sans options, et le handler construit alors paresseusement quatre dépôts
 * Drizzle. Or les tests unitaires ne chargent pas `.env` (aucun `globalSetup` dans
 * `vitest.config.ts`), donc `DATABASE_URL` est absent et `connection.ts` retombe sur
 * `file:./data/kisso.db` — la vraie base de développement.
 *
 * Le mode d'échec précis, constaté : les compteurs de `rate_limit_counters` et les clés de
 * `slack_event_dedup` PERSISTENT entre les tests et entre les runs. La rafale par défaut étant
 * de 5 messages/minute pour un même auteur, le 6ᵉ événement du fichier repartait en
 * `rate_limited`, aucun travail de fond n'était programmé, et quatre tests tombaient — dont
 * « hands the Slack background work to waitUntil ». La suite ne passait auparavant que parce
 * que ces deux tables étaient ABSENTES de la base locale : le limiteur et la déduplication
 * dégradaient alors en mémoire, par instance. Un test vert par absence de table n'est pas un
 * test vert, et il redevient rouge sur toute machine où `npm run db:init` a créé le schéma.
 *
 * Même doctrine que `makeHandler` dans `slack-events.handler.test.ts` : chaque dépôt est
 * explicitement `null` (désactivé) ou remplacé par une doublure NEUVE à chaque test.
 */
function resetRouteHandlerWithTestDoubles(): void {
  resetSlackEventsHandler();
  setSlackEventsHandlerOptionsForTests({
    // `null` et non `undefined` : `undefined` signifie « construis le dépôt Drizzle ».
    conversationRepository: null,
    // Doublure NEUVE à chaque test : c'est elle qui garantit qu'aucune clé de déduplication
    // ne survit d'un test à l'autre. Elle reste partagée à l'intérieur d'un test, donc le cas
    // « rejeu du même `event_id` » est toujours réellement exercé.
    dedupRepository: new InMemorySlackEventDedupRepository(),
    // `null` désactive l'annuaire — donc aussi la politique d'accès, qui en dérive. Ces tests
    // portent sur la route (signature, ACK, ordonnancement du travail de fond), pas sur la
    // frontière d'autorisation, qui a ses propres tests.
    directoryRepository: null,
    // ⚠️ La ligne dont l'absence a coûté les quatre échecs. Sans elle, `getRateLimiter()`
    // construit un `DrizzleRateLimitRepository` et compte les messages de tous les tests
    // ensemble, dans un fichier qui survit au run.
    rateLimiter: null,
  });
}

// Aucune injection de test ne survit à un test : la couture est rendue à son état de
// production après chacun d'eux, y compris après le dernier du fichier.
afterEach(() => {
  resetSlackEventsHandler();
});

describe('Route: POST /slack/events', () => {
  const originalSecret = process.env.SLACK_SIGNING_SECRET;
  const originalToken = process.env.SLACK_BOT_TOKEN;

  beforeEach(() => {
    process.env.SLACK_SIGNING_SECRET = SECRET;
    process.env.SLACK_BOT_TOKEN = 'xoxb-unit-test';
    resetRouteHandlerWithTestDoubles();
    postMessage.mockClear();
    authTest.mockClear();
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.SLACK_SIGNING_SECRET;
    else process.env.SLACK_SIGNING_SECRET = originalSecret;
    if (originalToken === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = originalToken;
  });

  it('is mounted outside the reserved /api prefix', () => {
    expect(SLACK_EVENTS_PATH).toBe('/slack/events');
    expect(SLACK_EVENTS_PATH.startsWith('/api')).toBe(false);
    expect(slackEventsRoute.method).toBe('POST');
    expect(slackEventsRoute.path).toBe('/slack/events');
  });

  it('echoes the url_verification challenge (signature still enforced)', async () => {
    const result = await callRoute({ type: 'url_verification', challenge: 'chal-42' });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ challenge: 'chal-42' });
  });

  it('rejects url_verification with a bad signature — Slack signs it too', async () => {
    const result = await callRoute(
      { type: 'url_verification', challenge: 'chal-42' },
      { signature: `v0=${'0'.repeat(64)}` },
    );
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'unauthorized', reason: 'invalid_signature' });
  });

  it('rejects a forged signature with 401', async () => {
    const result = await callRoute(eventCallback(dmEvent(), 'Ev0FORGED'), {
      secret: 'attacker-secret',
    });
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'unauthorized', reason: 'invalid_signature' });
  });

  it('rejects a stale timestamp with 401', async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 60 * 10);
    const result = await callRoute(eventCallback(dmEvent(), 'Ev0STALE'), { timestamp: stale });
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'unauthorized', reason: 'stale_timestamp' });
  });

  it('rejects with 401 when SLACK_SIGNING_SECRET is not configured (fail closed)', async () => {
    delete process.env.SLACK_SIGNING_SECRET;
    const result = await callRoute(eventCallback(dmEvent(), 'Ev0NOSECRET'), { secret: SECRET });
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'unauthorized', reason: 'missing_signing_secret' });
  });

  it('returns 400 on a validly-signed but non-JSON body', async () => {
    const rawBody = 'not json at all';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const result = await invokeRoute(
      makeContext(
        rawBody,
        {
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': computeSlackSignature(SECRET, timestamp, rawBody),
        },
        makeMastra().mastra,
      ),
    );
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: 'invalid_json' });
  });

  it('ACKs a DM immediately (before the agent has produced anything)', async () => {
    const { mastra, generate } = makeMastra();
    // L'agent ne répondra que lorsque le test le décidera : cela simule les 2 à 17 s
    // d'un appel LLM, très au-delà de la limite de 3 s imposée par Slack.
    let resolveAgent!: (value: { text: string }) => void;
    const pendingAgent = new Promise<{ text: string }>((resolve) => {
      resolveAgent = resolve;
    });
    generate.mockReturnValue(pendingAgent);

    const result = await callRoute(eventCallback(dmEvent(), 'Ev0ACK'), { mastra });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });

    await vi.waitFor(() => expect(generate).toHaveBeenCalled());

    // Le marqueur de progression est posté SANS attendre le modèle — c'est tout son
    // intérêt : l'utilisateur voit que sa demande est prise en compte pendant les 2 à 17 s
    // de l'appel LLM. Mais AUCUNE réponse d'agent n'a encore été délivrée.
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: PROGRESS_MARKER_TEXT }),
    );
    expect(updateMessage).not.toHaveBeenCalled();

    resolveAgent({ text: 'réponse tardive' });

    // La réponse REMPLACE le marqueur : un seul message dans le fil, jamais deux.
    await vi.waitFor(() =>
      expect(updateMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'réponse tardive' }),
      ),
    );
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it('routes an app_mention to the keyword-selected agent in the background', async () => {
    const { mastra, getAgent } = makeMastra();

    const result = await callRoute(
      eventCallback(
        {
          type: 'app_mention',
          user: 'U000HUMAN01',
          text: `<@${BOT_USER_ID}> lance le questionnaire`,
          channel: 'C0MOCKCHAN',
          channel_type: 'channel',
          ts: '1700000000.000100',
        },
        'Ev0MENTION',
      ),
      { mastra },
    );

    expect(result.status).toBe(200);
    await vi.waitFor(() => expect(getAgent).toHaveBeenCalledWith('questionnaireEngine'));
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'C0MOCKCHAN', thread_ts: '1700000000.000100' }),
      ),
    );
  });

  it('ACKs 200 but never calls an agent for the bot’s own message', async () => {
    const { mastra, getAgent } = makeMastra();

    const result = await callRoute(
      eventCallback(dmEvent({ bot_id: 'B0BM9MK4G65', subtype: 'bot_message' }), 'Ev0SELF'),
      { mastra },
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
    expect(getAgent).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('ACKs 200 but processes a duplicated event_id only once', async () => {
    const { mastra, getAgent } = makeMastra();
    const payload = eventCallback(dmEvent(), 'Ev0RETRY');

    const first = await callRoute(payload, { mastra });
    const retry = await callRoute(payload, { mastra, retryNum: '1' });

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    await vi.waitFor(() => expect(getAgent).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
  });

  it('ignores a plain channel message (only app_mention answers in channels)', async () => {
    const { mastra, getAgent } = makeMastra();

    const result = await callRoute(
      eventCallback(dmEvent({ channel: 'C0MOCKCHAN', channel_type: 'channel' }), 'Ev0CHANMSG'),
      { mastra },
    );

    expect(result.status).toBe(200);
    expect(getAgent).not.toHaveBeenCalled();
  });
});

/**
 * Le chemin pré-ACK n'a que 3 secondes, et son dépassement n'est PAS observable depuis la
 * fonction : quand l'ACK part à 3,4 s on voit un `200` parfaitement normal dans les logs, et
 * un doublon inexplicable dans Slack. C'est exactement ce qui s'est passé le 2026-08-11
 * 12:38 UTC — l'incident n'a été reconstruit qu'après coup, par déduction, à partir de deux
 * messages contradictoires postés dans un fil.
 */
describe('Route: budget d’ACK Slack', () => {
  // Chaque `describe` de ce fichier pose lui-même son secret de signature : les hooks d'un
  // bloc frère ne s'appliquent pas ici, et sans secret la route échoue FERMÉ (401) avant
  // même d'atteindre le chemin qu'on prétend mesurer. Le test lisait alors un 401 comme un
  // défaut d'ACK — exactement le genre de faux signal que ce bloc existe pour éviter.
  beforeEach(() => {
    process.env.SLACK_SIGNING_SECRET = SECRET;
    process.env.SLACK_BOT_TOKEN = 'xoxb-unit-test';
    resetRouteHandlerWithTestDoubles();
    postMessage.mockClear();
  });

  afterEach(() => {
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.SLACK_BOT_TOKEN;
  });

  it('tient le contrat Slack : 3 s, et une alerte à mi-parcours', () => {
    // Le chiffre n'est pas un réglage : c'est le délai au-delà duquel Slack REJOUE.
    expect(SLACK_ACK_BUDGET_MS).toBe(3_000);
    expect(SLACK_ACK_AT_RISK_MS).toBeLessThan(SLACK_ACK_BUDGET_MS);
  });

  it('nomme chaque état plutôt que de dégrader en silence', () => {
    expect(classifyAckLatency(0)).toBe('ok');
    expect(classifyAckLatency(SLACK_ACK_AT_RISK_MS - 1)).toBe('ok');
    expect(classifyAckLatency(SLACK_ACK_AT_RISK_MS)).toBe('at_risk');
    expect(classifyAckLatency(SLACK_ACK_BUDGET_MS - 1)).toBe('at_risk');
    // À partir d'ici, Slack a déjà rejoué : un second traitement est en vol quelque part.
    expect(classifyAckLatency(SLACK_ACK_BUDGET_MS)).toBe('exceeded');
    expect(classifyAckLatency(6_700)).toBe('exceeded');
  });

  it('reste silencieux sur le cas nominal — un ACK rapide n’a rien à signaler', async () => {
    const { mastra } = makeMastra();
    const result = await callRoute(eventCallback(dmEvent(), 'Ev0BUDGET'), { mastra });

    expect(result.status).toBe(200);
    expect(classifyAckLatency(0)).toBe('ok');
  });
});

/**
 * Le bug de production : Vercel gèle la fonction dès la réponse envoyée, ce qui tue
 * l'appel LLM lancé en `void promise`. La route doit déclarer ce travail au lanceur via
 * `waitUntil` — lu directement sur `globalThis[Symbol.for('@vercel/request-context')]`,
 * exactement comme le fait `@vercel/functions`.
 *
 * `hono/vercel` n'est PAS une option : son `handle = (app) => (req) => app.fetch(req)`
 * n'transmet jamais d'ExecutionContext, donc `c.executionCtx` lève.
 */
describe('Route: prolongation du traitement de fond (waitUntil)', () => {
  const VERCEL_REQUEST_CONTEXT = Symbol.for('@vercel/request-context');
  const holder = globalThis as typeof globalThis & Record<symbol, unknown>;
  const originalContext = holder[VERCEL_REQUEST_CONTEXT];
  const originalVercelEnv = process.env.VERCEL;

  function installVercelContext(waitUntil?: (p: Promise<unknown>) => void) {
    Object.defineProperty(holder, VERCEL_REQUEST_CONTEXT, {
      configurable: true,
      enumerable: false,
      value: { get: () => (waitUntil ? { waitUntil } : {}) },
    });
  }

  beforeEach(() => {
    process.env.SLACK_SIGNING_SECRET = SECRET;
    process.env.SLACK_BOT_TOKEN = 'xoxb-unit-test';
    resetRouteHandlerWithTestDoubles();
    postMessage.mockClear();
  });

  afterEach(() => {
    if (originalContext === undefined) {
      delete holder[VERCEL_REQUEST_CONTEXT];
    } else {
      Object.defineProperty(holder, VERCEL_REQUEST_CONTEXT, {
        configurable: true,
        enumerable: false,
        value: originalContext,
      });
    }
    if (originalVercelEnv === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = originalVercelEnv;
  });

  it('reports no waitUntil outside Vercel', () => {
    delete holder[VERCEL_REQUEST_CONTEXT];
    expect(getVercelWaitUntil()).toBeUndefined();
    expect(scheduleBackgroundWork(Promise.resolve())).toBe('detached');
  });

  it('picks up waitUntil from the Vercel request context', () => {
    const waitUntil = vi.fn();
    installVercelContext(waitUntil);

    const work = Promise.resolve('done');
    expect(scheduleBackgroundWork(work)).toBe('vercel-wait-until');
    expect(waitUntil).toHaveBeenCalledWith(work);
  });

  it('falls back to detached when the context exposes no waitUntil', () => {
    installVercelContext(undefined);
    expect(getVercelWaitUntil()).toBeUndefined();
    expect(scheduleBackgroundWork(Promise.resolve())).toBe('detached');
  });

  it('hands the Slack background work to waitUntil so the freeze cannot kill it', async () => {
    const pending: Promise<unknown>[] = [];
    installVercelContext((p) => pending.push(p));
    process.env.VERCEL = '1';

    const { mastra } = makeMastra('réponse agent');
    const result = await callRoute(eventCallback(dmEvent(), 'Ev0WAITUNTIL'), { mastra });

    expect(result.status).toBe(200);
    // Le travail a été déclaré AVANT le retour de la réponse : c'est ce qui empêche
    // Vercel de geler l'instance pendant l'appel LLM.
    expect(pending).toHaveLength(1);

    // La promesse déclarée est déjà « catchée » : jamais de rejet non géré.
    await expect(pending[0]).resolves.toBeUndefined();
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it('does not schedule anything for an ignored event', async () => {
    const waitUntil = vi.fn();
    installVercelContext(waitUntil);

    const { mastra } = makeMastra();
    await callRoute(
      eventCallback(dmEvent({ bot_id: 'B0BM9MK4G65', subtype: 'bot_message' }), 'Ev0NOSCHED'),
      { mastra },
    );

    expect(waitUntil).not.toHaveBeenCalled();
  });
});

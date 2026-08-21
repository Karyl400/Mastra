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
import { DrizzlePendingInterviewEmailRepository } from '../features/recruitment/infrastructure/repositories/drizzle-pending-email.repository';
import { KnowledgeIngestionService } from '../features/knowledge/application/services/knowledge-ingestion.service';
import { ModelFactSummarizer } from '../features/knowledge/infrastructure/services/model-fact-summarizer.service';
import { DrizzleMessageArchiveRepository } from '../features/knowledge/infrastructure/repositories/drizzle-message-archive.repository';
import { DrizzleKnowledgeFactRepository } from '../features/knowledge/infrastructure/repositories/drizzle-knowledge-fact.repository';
import { createEmailProvider } from '../features/notification/infrastructure/providers/email-provider.factory';

export const SLACK_EVENTS_PATH = '/slack/events';

const VERCEL_REQUEST_CONTEXT = Symbol.for('@vercel/request-context');

interface VercelRequestContext {
  waitUntil?: (promise: Promise<unknown>) => void;
}

type VercelRequestContextHolder = {
  [VERCEL_REQUEST_CONTEXT]?: { get?: () => VercelRequestContext | undefined };
};

export type BackgroundMechanism = 'vercel-wait-until' | 'detached';

export function getVercelWaitUntil(): ((promise: Promise<unknown>) => void) | undefined {
  const holder = globalThis as typeof globalThis & VercelRequestContextHolder;
  const context = holder[VERCEL_REQUEST_CONTEXT]?.get?.();
  return typeof context?.waitUntil === 'function' ? context.waitUntil.bind(context) : undefined;
}

export function scheduleBackgroundWork(work: Promise<unknown>): BackgroundMechanism {
  const waitUntil = getVercelWaitUntil();
  if (waitUntil) {
    waitUntil(work);
    return 'vercel-wait-until';
  }
  return 'detached';
}

export const SLACK_ACK_BUDGET_MS = 3_000;

export const SLACK_ACK_AT_RISK_MS = 1_500;

export type AckBudgetState = 'ok' | 'at_risk' | 'exceeded';

export function classifyAckLatency(elapsedMs: number): AckBudgetState {
  if (elapsedMs >= SLACK_ACK_BUDGET_MS) return 'exceeded';
  if (elapsedMs >= SLACK_ACK_AT_RISK_MS) return 'at_risk';
  return 'ok';
}

function reportAckBudget(state: AckBudgetState, details: Record<string, unknown>): void {
  if (state === 'exceeded') {
    logger.error('Slack ACK budget exceeded — Slack has already replayed this event', details);
  } else if (state === 'at_risk') {
    logger.warn('Slack ACK budget at risk', details);
  }
}

export interface SlackRouteContext {
  req: {
    text(): Promise<string>;
    header(name: string): string | undefined;
  };
  get(key: 'mastra'): Mastra;
  json(body: unknown, status?: number): Response;
}

let cachedHandler: SlackEventsHandler | undefined;
let cachedMastra: Mastra | undefined;

let handlerOptionsForTests: SlackEventsHandlerOptions | undefined;

let cachedEventsEmailProvider: ReturnType<typeof createEmailProvider> | undefined;

function getEventsEmailProvider() {
  cachedEventsEmailProvider ??= createEmailProvider();
  return cachedEventsEmailProvider;
}

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
      interviewRepository: new DrizzleOnboardingInterviewRepository(),
      profileRepository: new DrizzleEmployeeRepository(),
      pendingEmailRepository: new DrizzlePendingInterviewEmailRepository(),
      knowledgeIngestion: new KnowledgeIngestionService({
        archive: new DrizzleMessageArchiveRepository(),
        facts: new DrizzleKnowledgeFactRepository(),
        // ⚠️ Le SECOND RIDEAU. Il ne tourne que sur les messages que le code déterministe n'a
        // pas su classer, et seulement par lots de cinq : sur le chemin nominal, il ne coûte
        // pas un seul appel de modèle. Voir `fact-curtain.service.ts`.
        summarizer: new ModelFactSummarizer(),
      }),
      sendEmail: (to, subject, body) => getEventsEmailProvider().sendEmail(to, subject, body),
      ...handlerOptionsForTests,
    });
    cachedMastra = mastra;
  }
  return cachedHandler;
}

export function setSlackEventsHandlerOptionsForTests(
  options: SlackEventsHandlerOptions | undefined,
): void {
  handlerOptionsForTests = options;
  cachedHandler = undefined;
  cachedMastra = undefined;
}

export function resetSlackEventsHandler(): void {
  cachedHandler = undefined;
  cachedMastra = undefined;
  handlerOptionsForTests = undefined;
}

export async function handleSlackEventRequest(c: SlackRouteContext): Promise<Response> {
  const startedAt = Date.now();

  const rawBody = await c.req.text();

  const verification = verifySlackSignature({
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    timestamp: c.req.header('x-slack-request-timestamp'),
    signature: c.req.header('x-slack-signature'),
    rawBody,
  });

  if (!verification.valid) {
    logger.warn('Rejected Slack request', { reason: verification.reason });
    return c.json({ error: 'unauthorized', reason: verification.reason }, 401);
  }

  let body: SlackEventEnvelope;
  try {
    body = JSON.parse(rawBody) as SlackEventEnvelope;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  if (body.type === 'url_verification') {
    logger.info('Handling Slack URL verification');
    return c.json({ challenge: body.challenge ?? '' });
  }

  const handler = getSlackEventsHandler(c.get('mastra'));

  const retryNum = c.req.header('x-slack-retry-num');

  const admissionStartedAt = Date.now();
  const decision = await handler.accept(body, { retryNum });
  const admissionMs = Date.now() - admissionStartedAt;

  if (decision.action === 'process') {
    const work = handler.handleEvent(body).catch((error) => {
      logger.error('Background Slack event processing failed', {
        error,
        eventId: body.event_id,
        eventType: body.event?.type,
      });
    });

    const mechanism = scheduleBackgroundWork(work);

    logger.info('Slack event scheduled', {
      mechanism,
      eventId: body.event_id,
      eventType: body.event?.type,
      retryNum: retryNum ?? null,
    });

    if (mechanism === 'detached' && process.env.VERCEL) {
      logger.error('Slack background work is detached on Vercel — waitUntil unavailable', {
        eventId: body.event_id,
      });
    }
  } else {
    // ⚠️ Écarté pour la RÉPONSE, pas pour la CONNAISSANCE. Un message de canal est écarté par
    // `rejectMessage` (`not_a_dm`) — c'est le cas nominal, et c'est justement celui qu'il faut
    // archiver. Le rejet protège le budget de modèle ; il ne dit rien de ce qui mérite d'être su.
    scheduleBackgroundWork(
      handler.ingest(body).catch((error) => {
        logger.warn('Knowledge ingestion failed for an ignored Slack event', {
          error,
          eventId: body.event_id,
        });
      }),
    );

    logger.debug('Slack event ignored', { reason: decision.reason, eventId: body.event_id });
  }

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

export const SLACK_EVENTS_WORK_PATH = '/internal/slack/events';

function slackEventsRouteAt(path: string) {
  return registerApiRoute(path, {
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
}

export const slackEventsRoute = slackEventsRouteAt(SLACK_EVENTS_PATH);
export const slackEventsWorkRoute = slackEventsRouteAt(SLACK_EVENTS_WORK_PATH);

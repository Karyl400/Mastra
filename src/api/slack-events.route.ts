import { registerApiRoute } from '@mastra/core/server';
import type { Mastra } from '@mastra/core';

import { type SlackEventEnvelope } from '../features/notification/infrastructure/handlers/slack-events.handler';
import { verifySlackSignature } from '../shared/security/slack-signature';
import { logger } from '../shared/logger';
import { scheduleBackgroundWork } from './background-work';
import { classifyAckLatency, reportAckBudget } from './slack-ack-budget';
import { getSlackEventsHandler } from './slack-events-handler.factory';

export {
  type BackgroundMechanism,
  getVercelWaitUntil,
  scheduleBackgroundWork,
} from './background-work';
export {
  SLACK_ACK_BUDGET_MS,
  SLACK_ACK_AT_RISK_MS,
  type AckBudgetState,
  classifyAckLatency,
} from './slack-ack-budget';
export {
  getSlackEventsHandler,
  setSlackEventsHandlerOptionsForTests,
  resetSlackEventsHandler,
} from './slack-events-handler.factory';

export const SLACK_EVENTS_PATH = '/slack/events';

export interface SlackRouteContext {
  req: {
    text(): Promise<string>;
    header(name: string): string | undefined;
  };
  get(key: 'mastra'): Mastra;
  json(body: unknown, status?: number): Response;
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

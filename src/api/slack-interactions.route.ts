import { registerApiRoute } from '@mastra/core/server';
import type { Mastra } from '@mastra/core';

import { verifySlackSignature } from '../shared/security/slack-signature';
import { logger } from '../shared/logger';
import { judgeWorkspace } from '../shared/slack-team';
import { ack, jsonResponse } from './slack-interaction-replies';
import { handleBlockActions, handleViewSubmission } from './slack-interaction-dispatch';
import { type SlackInteractionPayload } from './slack-interaction-payload';

export {
  type SlackInteractionUser,
  type SlackBlockAction,
  type SlackInteractionPayload,
} from './slack-interaction-payload';
export {
  getSlackInteractionsAdapter,
  resetSlackInteractionsAdapter,
} from './slack-interaction-replies';
export { resetSettledCards } from './interview-card';
export { resetRecruitmentDependencies } from './interview-send.action';

export const SLACK_INTERACTIONS_PATH = '/slack/interactions';

export interface SlackInteractionsContext {
  req: {
    text(): Promise<string>;
    header(name: string): string | undefined;
  };
  get(key: 'mastra'): Mastra;
}

export async function handleSlackInteractionRequest(
  c: SlackInteractionsContext,
): Promise<Response> {
  const rawBody = await c.req.text();

  const verification = verifySlackSignature({
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    timestamp: c.req.header('x-slack-request-timestamp'),
    signature: c.req.header('x-slack-signature'),
    rawBody,
  });

  if (!verification.valid) {
    logger.warn('Rejected Slack interaction', { reason: verification.reason });
    return jsonResponse({ error: 'unauthorized', reason: verification.reason }, 401);
  }

  const params = new URLSearchParams(rawBody);

  if (params.get('ssl_check') === '1') {
    logger.info('Slack ssl_check acknowledged');
    return ack();
  }

  const encoded = params.get('payload');
  if (!encoded) {
    logger.warn('Slack interaction without a payload field');
    return jsonResponse({ error: 'missing_payload' }, 400);
  }

  let payload: SlackInteractionPayload;
  try {
    payload = JSON.parse(encoded) as SlackInteractionPayload;
  } catch (error) {
    logger.warn('Slack interaction payload is not valid JSON', { error });
    return jsonResponse({ error: 'invalid_payload' }, 400);
  }

  const workspace = judgeWorkspace(payload.team?.id, process.env.SLACK_TEAM_ID);
  if (!workspace.accepted) {
    logger.warn('Interaction Slack venue d’un workspace inattendu — ignorée', {
      received: workspace.received,
      expected: workspace.expected,
      type: payload.type,
    });
    return ack();
  }

  if (payload.type === 'block_actions') {
    return handleBlockActions(payload);
  }
  if (payload.type === 'view_submission') {
    return handleViewSubmission(payload);
  }

  logger.debug('Slack interaction ignored', { type: payload.type });
  return ack();
}

export const SLACK_INTERACTIONS_WORK_PATH = '/internal/slack/interactions';

function slackInteractionsRouteAt(path: string) {
  return registerApiRoute(path, {
    method: 'POST',
    requiresAuth: false,
    openapi: {
      summary: 'Slack interactivity webhook',
      description:
        'Reçoit les interactions Slack (block_actions, view_submission). ' +
        'Signature HMAC-SHA256 vérifiée. Ouvre la modale de profil et valide sa soumission.',
      tags: ['slack'],
      responses: {
        200: { description: 'Interaction accusée (corps vide) ou erreurs de validation' },
        400: { description: 'Payload absent ou illisible' },
        401: { description: 'Signature Slack invalide, absente ou expirée' },
      },
    },
    handler: async (c) => handleSlackInteractionRequest(c as unknown as SlackInteractionsContext),
  });
}

export const slackInteractionsRoute = slackInteractionsRouteAt(SLACK_INTERACTIONS_PATH);
export const slackInteractionsWorkRoute = slackInteractionsRouteAt(SLACK_INTERACTIONS_WORK_PATH);

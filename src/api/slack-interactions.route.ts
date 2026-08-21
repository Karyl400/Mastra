import { registerApiRoute } from '@mastra/core/server';
import type { Mastra } from '@mastra/core';

import { SlackAdapter } from '../features/notification/infrastructure/providers/slack.adapter';
const PROFILE_DONE_ACTION_ID = 'profile_done';

import { verifyProfile } from '../features/onboarding/domain/services/profile-completion';
import { DrizzleEmployeeRepository } from '../features/employee/infrastructure/repositories/drizzle-employee.repository';
import {
  SEND_INTERVIEW_ACTION_ID,
  CANCEL_INTERVIEW_ACTION_ID,
  INTERVIEW_SENT_REPLY,
  INTERVIEW_CANCELLED_REPLY,
  INTERVIEW_NOT_YOURS_REPLY,
  INTERVIEW_SEND_FAILED_REPLY,
  decodeInterviewConfirm,
  buildSettledCardBlocks,
  confirmFacts,
} from '../features/recruitment/infrastructure/handlers/interview-confirm';
import { parseInterviewSchedule } from '../features/recruitment/domain/value-objects/interview-schedule';
import { buildInterviewEmail } from '../features/recruitment/domain/services/interview-email';
import { createEmailProvider } from '../features/notification/infrastructure/providers/email-provider.factory';
import type { EmailProvider } from '../features/notification/domain/ports/providers';
import { textEmailBody } from '../features/notification/domain/services/email-body';
import { type NewcomerIdentity } from '../features/onboarding/domain/services/newcomer-identity';
import { scheduleBackgroundWork } from './slack-events.route';
import { verifySlackSignature } from '../shared/security/slack-signature';
import { logger } from '../shared/logger';
import { DrizzleConversationRepository } from '../features/conversation/infrastructure/repositories/drizzle-conversation.repository';
import { deriveConversationId } from '../features/conversation/domain/value-objects/conversation-id';
import { DEFAULT_AGENT_ID } from '../features/notification/domain/services/agent-routing';
import { judgeWorkspace } from '../shared/slack-team';

export const SLACK_INTERACTIONS_PATH = '/slack/interactions';

interface SlackInteractionUser {
  id?: string;
  name?: string;
}

interface SlackBlockAction {
  action_id?: string;
  value?: string;
}

interface SlackInteractionPayload {
  type?: string;
  trigger_id?: string;
  user?: SlackInteractionUser;
  team?: { id?: string };
  actions?: SlackBlockAction[];
  view?: {
    callback_id?: string;
    private_metadata?: string;
  };
  channel?: { id?: string };
  message?: { ts?: string; thread_ts?: string };
}

function decodeLegacyProfileButton(
  value: string | undefined,
  fallbackUserId = '',
): NewcomerIdentity {
  if (!value) return { slackUserId: fallbackUserId };

  try {
    const parsed = JSON.parse(value) as {
      u?: string;
      e?: string;
      f?: string;
      l?: string;
      j?: string;
    };
    return {
      slackUserId: parsed.u || fallbackUserId,
      email: parsed.e ?? null,
      firstName: parsed.f ?? null,
      lastName: parsed.l ?? null,
      joinedAt: parsed.j ?? null,
    };
  } catch {
    return { slackUserId: value || fallbackUserId };
  }
}

export interface SlackInteractionsContext {
  req: {
    text(): Promise<string>;
    header(name: string): string | undefined;
  };
  get(key: 'mastra'): Mastra;
}

function ack(): Response {
  return new Response(null, { status: 200 });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let cachedAdapter: SlackAdapter | undefined;

export function getSlackInteractionsAdapter(): SlackAdapter {
  cachedAdapter ??= new SlackAdapter(process.env.SLACK_BOT_TOKEN ?? '');
  return cachedAdapter;
}

export function resetSlackInteractionsAdapter(): void {
  cachedAdapter = undefined;
}

async function handleBlockActions(payload: SlackInteractionPayload): Promise<Response> {
  const actions = payload.actions ?? [];

  const doneAction = actions.find((a) => a.action_id === PROFILE_DONE_ACTION_ID);
  if (doneAction) {
    const prefill = decodeLegacyProfileButton(doneAction.value, payload.user?.id ?? '');
    scheduleInteractionWork(
      'profile_done',
      answerProfileDone(prefill).catch((error: unknown) => {
        logger.error('Vérification « C’est fait » échouée', { error: String(error) });
      }),
    );
    return ack();
  }

  if (actions.some((a) => a.action_id === CANCEL_INTERVIEW_ACTION_ID)) {
    if (!claimCard(payload)) {
      logger.info('Carte d’entretien déjà tranchée — clic ignoré');
      return ack();
    }

    scheduleInteractionWork(
      'interview_cancel',
      settleCard(payload, INTERVIEW_CANCELLED_REPLY)
        .then(() => replyInThread(payload, INTERVIEW_CANCELLED_REPLY))
        .catch((error: unknown) => {
          logger.error('Réponse d’annulation non postée', { error: String(error) });
        }),
    );
    return ack();
  }

  const sendAction = actions.find((a) => a.action_id === SEND_INTERVIEW_ACTION_ID);
  if (sendAction) {
    if (!claimCard(payload)) {
      logger.info('Carte d’entretien déjà tranchée — second clic ignoré');
      return ack();
    }

    scheduleInteractionWork(
      'interview_send',
      handleInterviewSend(payload, sendAction.value).catch((error: unknown) => {
        logger.error('Envoi d’entretien en tâche de fond échoué', { error: String(error) });
      }),
    );
    return ack();
  }

  logger.debug('block_actions sans action connue', {
    actions: actions.map((a) => a.action_id),
  });
  return ack();
}

let cachedEmailProvider: EmailProvider | undefined;

function getEmailProvider(): EmailProvider {
  cachedEmailProvider ??= createEmailProvider();
  return cachedEmailProvider;
}

export function resetRecruitmentDependencies(): void {
  cachedEmailProvider = undefined;
}

function scheduleInteractionWork(label: string, work: Promise<unknown>): void {
  const mechanism = scheduleBackgroundWork(work);
  if (mechanism === 'detached' && process.env.VERCEL) {
    logger.error('Travail d’interactivité détaché sur Vercel — waitUntil indisponible', {
      work: label,
    });
  }
}

async function replyInThread(payload: SlackInteractionPayload, text: string): Promise<void> {
  const channel = payload.channel?.id;
  if (!channel) return;
  try {
    const isDirectMessage = channel.startsWith('D');
    const threadTs = isDirectMessage
      ? undefined
      : (payload.message?.thread_ts ?? payload.message?.ts);
    await getSlackInteractionsAdapter().sendMessage(channel, text, threadTs);
  } catch (error) {
    logger.error('Réponse de confirmation non postée', { error: String(error) });
  }
}

const settledCards = new Set<string>();

function cardKey(payload: SlackInteractionPayload): string | null {
  const channel = payload.channel?.id;
  const ts = payload.message?.ts;
  return channel && ts ? `${channel}:${ts}` : null;
}

function claimCard(payload: SlackInteractionPayload): boolean {
  const key = cardKey(payload);
  if (!key) return true;
  if (settledCards.has(key)) return false;
  settledCards.add(key);
  return true;
}

function releaseCard(payload: SlackInteractionPayload): void {
  const key = cardKey(payload);
  if (key) settledCards.delete(key);
}

export function resetSettledCards(): void {
  settledCards.clear();
}

async function settleCard(
  payload: SlackInteractionPayload,
  verdict: string,
  facts?: readonly string[],
): Promise<void> {
  const channel = payload.channel?.id;
  const ts = payload.message?.ts;
  if (!channel || !ts) return;
  try {
    await getSlackInteractionsAdapter().updateMessage(
      channel,
      ts,
      verdict,
      buildSettledCardBlocks({ verdict, facts }),
    );
  } catch (error) {
    logger.error('Carte d’entretien non neutralisée', { error: String(error) });
  }
}

async function handleInterviewSend(
  payload: SlackInteractionPayload,
  rawValue: string | undefined,
): Promise<void> {
  const confirm = decodeInterviewConfirm(rawValue);
  if (!confirm) {
    logger.warn('Confirmation d’entretien illisible');
    await settleCard(payload, INTERVIEW_SEND_FAILED_REPLY);
    await replyInThread(payload, INTERVIEW_SEND_FAILED_REPLY);
    return;
  }

  const clicker = payload.user?.id ?? '';
  if (clicker !== confirm.requesterUserId) {
    logger.warn('Envoi d’entretien refusé — cliqueur différent du demandeur');
    releaseCard(payload);
    await replyInThread(payload, INTERVIEW_NOT_YOURS_REPLY);
    return;
  }

  const parsed = parseInterviewSchedule(confirm.startsAt, new Date());
  if (!parsed.ok) {
    logger.warn('Envoi d’entretien refusé — date invalide au clic', { reason: parsed.reason });
    const expired = "Cette date n'est plus valide — rien n'est parti. Redemande-moi l'invitation.";
    await settleCard(payload, expired);
    await replyInThread(payload, expired);
    return;
  }

  const email = buildInterviewEmail({
    candidateName: confirm.candidateName,
    schedule: parsed.schedule,
    position: confirm.position,
    location: confirm.location,
    replyTo: confirm.replyTo,
  });

  try {
    await getEmailProvider().sendEmail(confirm.to, email.subject, textEmailBody(email.body));
  } catch (error) {
    logger.error('Email d’entretien NON envoyé', { error: String(error) });
    releaseCard(payload);
    await replyInThread(payload, INTERVIEW_SEND_FAILED_REPLY);
    return;
  }

  logger.info('Invitation d’entretien envoyée', {
    recipientDomain: confirm.to.split('@')[1] ?? 'inconnu',
    when: parsed.schedule.at.toISOString(),
    hasPosition: Boolean(confirm.position),
    hasLocation: Boolean(confirm.location),
  });

  const sent = INTERVIEW_SENT_REPLY(confirm.to, parsed.schedule.humanReadable);
  await settleCard(payload, sent, confirmFacts(confirm, parsed.schedule.humanReadable));
  await replyInThread(payload, sent);
}

let cachedEmployeeRepo: DrizzleEmployeeRepository | undefined;
function employeeRepo(): DrizzleEmployeeRepository {
  cachedEmployeeRepo ??= new DrizzleEmployeeRepository();
  return cachedEmployeeRepo;
}

async function answerProfileDone(prefill: NewcomerIdentity): Promise<void> {
  const email = prefill.email?.trim();
  const employee = email ? await employeeRepo().findByEmail(email) : null;
  const verdict = verifyProfile(employee);

  logger.info('« C’est fait » vérifié', {
    slackUserId: prefill.slackUserId,
    complete: verdict.complete,
    missing: verdict.missing.length,
  });

  await rememberAsked(prefill.slackUserId, verdict.reply);
}

async function tellNewcomer(slackUserId: string | undefined, text: string): Promise<void> {
  if (!slackUserId) {
    logger.warn('Verdict d’onboarding non transmis — aucun utilisateur Slack identifié');
    return;
  }
  try {
    await getSlackInteractionsAdapter().sendMessage(slackUserId, text);
  } catch (error) {
    logger.error('Verdict d’onboarding non transmis', { error: String(error) });
  }
}

async function rememberAsked(slackUserId: string | undefined, text: string): Promise<void> {
  if (!slackUserId) return;
  const { channel } = await getSlackInteractionsAdapter().sendMessage(slackUserId, text);

  try {
    await conversationRepo().append({
      conversationId: deriveConversationId({ channel }),
      role: 'assistant',
      content: text,
      agentId: DEFAULT_AGENT_ID,
      slackUserId: null,
    });
  } catch (error) {
    logger.error('Question d’entretien posée mais non mémorisée — la réponse ira à l’agent', {
      error: String(error),
    });
  }
}

let cachedConversationRepo: DrizzleConversationRepository | undefined;
function conversationRepo(): DrizzleConversationRepository {
  cachedConversationRepo ??= new DrizzleConversationRepository();
  return cachedConversationRepo;
}

const OBSOLETE_FORM_REPLY =
  'Ce formulaire ne fonctionne plus — je n’ai rien gardé de ce que tu viens de taper, désolé. ' +
  'On fait ça à l’écrit maintenant, c’est plus simple : écris-moi *« je veux compléter mon ' +
  'profil »* et je te guide, une question à la fois.';

function handleViewSubmission(payload: SlackInteractionPayload): Response {
  logger.warn('Soumission reçue d’une modale supprimée — la personne est prévenue', {
    callbackId: payload.view?.callback_id ?? 'inconnu',
  });

  scheduleInteractionWork(
    'obsolete_form_submission',
    tellNewcomer(payload.user?.id, OBSOLETE_FORM_REPLY),
  );

  return ack();
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

  if (payload.type === 'block_actions') return handleBlockActions(payload);
  if (payload.type === 'view_submission') return handleViewSubmission(payload);

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

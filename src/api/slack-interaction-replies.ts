import { SlackAdapter } from '../features/notification/infrastructure/providers/slack.adapter';
import { logger } from '../shared/logger';
import { scheduleBackgroundWork } from './background-work';
import { type SlackInteractionPayload } from './slack-interaction-payload';

export function ack(): Response {
  return new Response(null, { status: 200 });
}

export function jsonResponse(body: unknown, status = 200): Response {
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

export function scheduleInteractionWork(label: string, work: Promise<unknown>): void {
  const mechanism = scheduleBackgroundWork(work);
  if (mechanism === 'detached' && process.env.VERCEL) {
    logger.error('Travail d’interactivité détaché sur Vercel — waitUntil indisponible', {
      work: label,
    });
  }
}

export async function replyInThread(payload: SlackInteractionPayload, text: string): Promise<void> {
  const channel = payload.channel?.id;
  if (!channel) {
    return;
  }
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

export async function tellNewcomer(slackUserId: string | undefined, text: string): Promise<void> {
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

import { buildSettledCardBlocks } from '../features/recruitment/infrastructure/handlers/interview-confirm';
import { logger } from '../shared/logger';
import { getSlackInteractionsAdapter } from './slack-interaction-replies';
import { type SlackInteractionPayload } from './slack-interaction-payload';

const settledCards = new Set<string>();

function cardKey(payload: SlackInteractionPayload): string | null {
  const channel = payload.channel?.id;
  const ts = payload.message?.ts;
  return channel && ts ? `${channel}:${ts}` : null;
}

export function claimCard(payload: SlackInteractionPayload): boolean {
  const key = cardKey(payload);
  if (!key) {
    return true;
  }
  if (settledCards.has(key)) {
    return false;
  }
  settledCards.add(key);
  return true;
}

export function releaseCard(payload: SlackInteractionPayload): void {
  const key = cardKey(payload);
  if (key) {
    settledCards.delete(key);
  }
}

export function resetSettledCards(): void {
  settledCards.clear();
}

export async function settleCard(
  payload: SlackInteractionPayload,
  verdict: string,
  facts?: readonly string[],
): Promise<void> {
  const channel = payload.channel?.id;
  const ts = payload.message?.ts;
  if (!channel || !ts) {
    return;
  }
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

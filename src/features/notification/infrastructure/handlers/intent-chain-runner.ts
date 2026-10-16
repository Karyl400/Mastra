import { logger } from '../../../../shared/logger';
import {
  CHAIN_OUT_OF_TIME_NOTICE,
  CHAIN_STOPPED_NOTICE,
  planIntentChain,
} from '../../domain/services/intent-chain';
import { hasTimeForAnotherStep } from '../../../../shared/llm/run-deadline';
import { startProgress } from '../providers/slack-progress';
import type { AgentPipelineContext, SlackHandlerInternals } from './handler-internals';

export async function postPlainMessage(
  self: SlackHandlerInternals,
  channel: string,
  threadTs: string | undefined,
  text: string,
): Promise<void> {
  try {
    await self.slack.chat.postMessage({
      channel,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  } catch (error) {
    logger.warn('Slack — message complémentaire non posté', { channel, error });
  }
}

export async function runIntentChain(
  self: SlackHandlerInternals,
  ctx: AgentPipelineContext,
): Promise<void> {
  const chain = planIntentChain(ctx.text, ctx.history.at(-1)?.agentId);
  const steps = chain?.steps.length ? chain.steps : [{ text: ctx.text, agentId: '' }];

  if (steps.length > 1) {
    logger.info('Message à plusieurs demandes — enchaînement déterministe', {
      channel: ctx.channel,
      conversationId: ctx.conversationId,
      steps: steps.map((step) => step.agentId),
    });
  }

  for (const [index, step] of steps.entries()) {
    if (index > 0 && !hasTimeForAnotherStep(ctx.deadline, Date.now())) {
      logger.warn('Enchaînement interrompu — plus assez de temps pour l’étape suivante', {
        channel: ctx.channel,
        conversationId: ctx.conversationId,
        skipped: steps.length - index,
      });
      await postPlainMessage(self, ctx.channel, ctx.threadTs, CHAIN_OUT_OF_TIME_NOTICE);
      return;
    }

    const progress =
      index === 0
        ? ctx.progress
        : await startProgress(self.slack, { channel: ctx.channel, threadTs: ctx.threadTs });

    const outcome = await self.runAgentPipeline({
      ...ctx,
      text: step.text,
      progress,
      ...(index === 0 ? {} : { pendingEmailReminder: undefined, onboardingReminder: undefined }),
    });

    if (outcome === 'blocked' && index < steps.length - 1) {
      logger.info('Enchaînement interrompu — une étape n’a rien pu faire', {
        channel: ctx.channel,
        conversationId: ctx.conversationId,
        stoppedAt: step.agentId,
        skipped: steps.length - index - 1,
      });
      await postPlainMessage(self, ctx.channel, ctx.threadTs, CHAIN_STOPPED_NOTICE);
      return;
    }
  }
}

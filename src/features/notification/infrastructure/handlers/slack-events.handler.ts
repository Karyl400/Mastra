import { logger } from '../../../../shared/logger';
import { userFacingFailure } from '../../../../shared/user-facing-failure';
import {
  isTeamJoinEvent,
  type SlackAcceptContext,
  type SlackEvent,
  type SlackEventDecision,
  type SlackEventEnvelope,
  type SlackMessageEvent,
  type SlackTeamJoinEvent,
} from './slack-event.types';
import type {
  AgentPipelineContext,
  AgentTurnState,
  SlackHandlerInternals,
  StepOutcome,
} from './handler-internals';
import { SlackHandlerCore } from './handler-core';
import { dedupKey, markDedupDone, releaseDedup } from './event-dedup';
import { eventIsAnsweredWithoutModel } from './rate-limit-gate';
import { handleTeamJoin } from './team-join';
import { archiveChannelMessage } from './channel-archive';
import { maybeAdvanceOnboarding } from './onboarding-advance';
import { linkRequesterToRecord } from './profile-journey';
import type { InterviewStepInput } from './interview-journey';
import { runAgentTurn } from './agent-pipeline';
import { auditFailedRun } from './agent-run-audit';
import { acceptEvent } from './accept-event';
import { handleMessage } from './handle-message';

export class SlackEventsHandler extends SlackHandlerCore implements SlackHandlerInternals {
  async accept(
    envelope: SlackEventEnvelope,
    context: SlackAcceptContext = {},
  ): Promise<SlackEventDecision> {
    return await acceptEvent(this, envelope, context);
  }

  isAnsweredWithoutModel(event: SlackEvent): boolean {
    return eventIsAnsweredWithoutModel(event);
  }

  async maybeAdvanceOnboarding(input: InterviewStepInput): Promise<boolean> {
    return await maybeAdvanceOnboarding(this, input);
  }

  async linkRequesterToRecord(
    slackUserId: string | undefined,
    employeeId: string | undefined,
  ): Promise<void> {
    await linkRequesterToRecord(this, slackUserId, employeeId);
  }

  async ingest(envelope: SlackEventEnvelope): Promise<void> {
    const event = envelope.event;
    if (!event) return;
    await archiveChannelMessage(this, event);
  }

  async handleEvent(envelope: SlackEventEnvelope): Promise<void> {
    const key = dedupKey(envelope);
    try {
      await this.ingest(envelope);
      await this.processEvent(envelope);
      await markDedupDone(this, key);
    } catch (error) {
      await releaseDedup(this, key);
      throw error;
    }
  }

  private async processEvent(envelope: SlackEventEnvelope): Promise<void> {
    const event: SlackEvent | undefined = envelope.event;
    if (!event) return;

    if (isTeamJoinEvent(event)) {
      await this.handleTeamJoin(event);
      return;
    }

    const botUserId = await this.getBotUserId();
    if (botUserId && event.user === botUserId) {
      logger.debug('Ignoring own Slack message', { botUserId });
      return;
    }

    await this.handleMessage(event);
  }

  async handleTeamJoin(event: SlackTeamJoinEvent): Promise<void> {
    await handleTeamJoin(this, event);
  }

  async handleMessage(event: SlackMessageEvent): Promise<void> {
    await handleMessage(this, event);
  }

  async runAgentPipeline(ctx: AgentPipelineContext): Promise<StepOutcome> {
    const state: AgentTurnState = { phase: 'route', agentId: 'unknown', startedAt: Date.now() };

    try {
      return await runAgentTurn(this, ctx, state);
    } catch (error) {
      logger.error('Error processing Slack message', {
        error,
        errorType: error instanceof Error ? error.constructor.name : typeof error,
        phase: state.phase,
        agentId: state.agentId,
        conversationId: ctx.conversationId,
        channel: ctx.channel,
        textLength: ctx.text.length,
        user: ctx.user,
      });

      auditFailedRun(this, {
        user: ctx.user,
        agentId: state.agentId,
        error,
        phase: state.phase,
        startedAt: state.startedAt,
      });

      await ctx.progress.fail(userFacingFailure(error));
      return 'blocked';
    }
  }
}

export * from './public-api';

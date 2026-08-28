import { WebClient } from '@slack/web-api';
import { LRUCache } from 'lru-cache';
import type { Mastra } from '@mastra/core';
import { logger } from '../../../../shared/logger';
import { userFacingFailure } from '../../../../shared/user-facing-failure';
import { AUDIT_ACTIONS } from '../../../../shared/audit-actions';
import { routeToAgent } from '../../domain/services/agent-routing';
import { findActingReply } from '../../domain/services/deterministic-replies';
import { CONVERSATION_TOKEN_BUDGET } from '../../../conversation/domain/services/token-window';
import {
  CONVERSATION_TTL_MS,
  type ConversationRepository,
} from '../../../conversation/domain/ports/conversation.repository';
import { DrizzleConversationRepository } from '../../../conversation/infrastructure/repositories/drizzle-conversation.repository';
import { DrizzlePinnedFactRepository } from '../../../conversation/infrastructure/repositories/drizzle-pinned-fact.repository';
import type { PinnedFactRepository } from '../../../conversation/domain/ports/pinned-fact.repository';
import { DrizzleDirectoryRepository } from '../../../directory/infrastructure/repositories/drizzle-directory.repository';
import { SlackMemberSource } from '../../../directory/infrastructure/providers/slack-member-source.adapter';
import type { DirectoryRepository } from '../../../directory/domain/ports/directory.repository';
import type { WelcomeChannelsService } from '../../../directory/application/services/welcome-channels.service';
import { SlackAccessGuard } from '../../../directory/application/services/access-guard';
import { SlackAdapter } from '../providers/slack.adapter';
import { SlackWorkspaceService } from '../providers/slack-workspace.service';
import type { SlackWorkspaceProvider } from '../../domain/ports/slack-workspace.port';
import { startProgress } from '../providers/slack-progress';
import type { SlackEventDedupRepository } from '../../domain/ports/slack-event-dedup.repository';
import { DrizzleSlackEventDedupRepository } from '../repositories/drizzle-slack-event-dedup.repository';
import { SlackRateLimiter } from '../services/slack-rate-limiter';
import { writeAuditLog } from '../../../../infrastructure/audit/audit-log';
import type { RequesterIdentity } from '../../domain/services/context-preamble';
import type { OnboardingInterviewRepository } from '../../../onboarding/domain/ports/onboarding-interview.repository';
import { onboardingNudge } from '../../../onboarding/domain/services/onboarding-nudge';
import type { PendingInterviewEmailRepository } from '../../../recruitment/domain/ports/pending-email.repository';
import type { KnowledgeIngestionPort } from '../../../knowledge/application/services/knowledge-ingestion.service';
import type { KnowledgeErasurePort } from '../../../knowledge/application/services/knowledge-erasure.service';
import type { NotificationRepository } from '../../domain/ports/notification.repository';

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
  AuditSink,
  DedupEntry,
  ProfileRepositoryPort,
  SendEmailPort,
  SlackEventsHandlerOptions,
  SlackHandlerInternals,
  StepOutcome,
} from './handler-internals';
import { DEFAULT_PRUNE_PROBABILITY } from './conversation-memory';
import { dedupKey, markDedupDone, releaseDedup, DEFAULT_IN_FLIGHT_GRACE_MS } from './event-dedup';
import {
  chargeModelBudget,
  eventIsAnsweredWithoutModel,
  notifyRateLimited,
} from './rate-limit-gate';
import { handleTeamJoin } from './team-join';
import { archiveChannelMessage } from './channel-archive';
import { enforceAuthorization } from './requester-identity';
import { buildMessageContext, runStaticReply } from './message-context';
import { resolvePendingEmail } from './pending-email';
import { pendingOnboardingStep } from './onboarding-turn-state';
import { maybeAdvanceOnboarding } from './onboarding-advance';
import { linkRequesterToRecord } from './profile-journey';
import type { InterviewStepInput } from './interview-journey';
import { runErasure, runPinFact } from './acting-shortcuts';
import { runCancelReminder } from './reminder-cancellation';
import { runProfileForm } from './profile-form';
import { runAgentTurn } from './agent-pipeline';
import { auditFailedRun } from './agent-run-audit';
import { runIntentChain } from './intent-chain-runner';
import { buildAccessGuard } from './access-guard.factory';
import { buildRateLimiter } from './rate-limiter.factory';
import { acceptEvent } from './accept-event';

export class SlackEventsHandler implements SlackHandlerInternals {
  readonly slack: WebClient;
  readonly mastra: Mastra;
  readonly seenEvents: LRUCache<string, DedupEntry>;
  readonly inFlightGraceMs: number;
  private botUserIdPromise?: Promise<string | undefined>;
  readonly chatProvider: Pick<SlackAdapter, 'sendBlocks'>;
  readonly workspaceProvider: Pick<SlackWorkspaceProvider, 'findUserById'>;
  teamIdWarningEmitted = false;
  noAccessGuardLogged = false;
  private conversationRepo: ConversationRepository | null | undefined;
  private pinnedFactRepo: PinnedFactRepository | null | undefined;
  readonly interviewRepo: OnboardingInterviewRepository | null | undefined;
  readonly profileRepo: ProfileRepositoryPort | null | undefined;
  private dedupRepo: SlackEventDedupRepository | null | undefined;
  readonly conversationTokenBudget: number;
  readonly conversationTtlMs: number;
  private directoryRepo: DirectoryRepository | null | undefined;
  readonly welcomeChannels: WelcomeChannelsService | null;
  private guard: SlackAccessGuard | null | undefined;
  private limiter: SlackRateLimiter | null | undefined;
  readonly pruneProbability: number;
  readonly requesterNames = new LRUCache<string, RequesterIdentity>({
    max: 500,
    ttl: 12 * 60 * 60 * 1000,
    allowStale: false,
  });

  private readonly botToken: string;

  readonly audit: AuditSink;

  readonly pendingEmailRepo: PendingInterviewEmailRepository | null | undefined;
  readonly now: () => Date;
  readonly knowledgeIngestion: KnowledgeIngestionPort | null | undefined;
  readonly knowledgeErasure: KnowledgeErasurePort | null | undefined;
  readonly notificationRepo: NotificationRepository | null | undefined;
  readonly sendEmail: SendEmailPort | undefined;

  constructor(botToken: string, mastra: Mastra, options: SlackEventsHandlerOptions = {}) {
    this.botToken = botToken;
    this.slack = options.slackClient ?? new WebClient(botToken);
    this.mastra = mastra;
    this.audit = options.auditSink ?? writeAuditLog;
    this.chatProvider = options.chatProvider ?? new SlackAdapter(botToken);
    this.workspaceProvider = options.workspaceProvider ?? new SlackWorkspaceService(botToken);
    this.inFlightGraceMs = options.inFlightGraceMs ?? DEFAULT_IN_FLIGHT_GRACE_MS;
    this.conversationRepo = options.conversationRepository;
    this.pinnedFactRepo = options.pinnedFactRepository;
    this.interviewRepo = options.interviewRepository;
    this.profileRepo = options.profileRepository;
    this.pendingEmailRepo = options.pendingEmailRepository;
    this.now = options.now ?? (() => new Date());
    this.sendEmail = options.sendEmail;
    this.knowledgeIngestion = options.knowledgeIngestion;
    this.knowledgeErasure = options.knowledgeErasure;
    this.notificationRepo = options.notificationRepository;
    this.dedupRepo = options.dedupRepository;
    this.conversationTokenBudget = options.conversationTokenBudget ?? CONVERSATION_TOKEN_BUDGET;
    this.conversationTtlMs = options.conversationTtlMs ?? CONVERSATION_TTL_MS;
    this.directoryRepo = options.directoryRepository;
    this.welcomeChannels = options.welcomeChannels ?? null;
    this.guard = options.accessGuard;
    this.limiter = options.rateLimiter;
    this.pruneProbability = options.pruneProbability ?? DEFAULT_PRUNE_PROBABILITY;
    this.seenEvents = new LRUCache<string, DedupEntry>({
      max: options.dedupMax ?? 1000,
      ttl: options.dedupTtlMs ?? 10 * 60 * 1000,
    });
  }

  getDedupRepo(): SlackEventDedupRepository | null {
    if (this.dedupRepo === undefined) {
      this.dedupRepo = new DrizzleSlackEventDedupRepository();
    }
    return this.dedupRepo;
  }

  getConversationRepo(): ConversationRepository | null {
    if (this.conversationRepo === undefined) {
      this.conversationRepo = new DrizzleConversationRepository();
    }
    return this.conversationRepo;
  }

  getPinnedFactRepo(): PinnedFactRepository | null {
    if (this.pinnedFactRepo === undefined) {
      this.pinnedFactRepo = new DrizzlePinnedFactRepository();
    }
    return this.pinnedFactRepo;
  }

  routeToAgent(text: string, stickyAgentId?: string): string {
    return routeToAgent(text, stickyAgentId);
  }

  getDirectoryRepo(): DirectoryRepository | null {
    if (this.directoryRepo === undefined) {
      this.directoryRepo = new DrizzleDirectoryRepository();
    }
    return this.directoryRepo;
  }

  getAccessGuard(): SlackAccessGuard | null {
    if (this.guard === undefined) {
      this.guard = buildAccessGuard(
        this.getDirectoryRepo(),
        new SlackMemberSource(new SlackWorkspaceService(this.botToken)),
      );
    }
    return this.guard;
  }

  getRateLimiter(): SlackRateLimiter | null {
    if (this.limiter === undefined) {
      this.limiter = buildRateLimiter();
    }
    return this.limiter;
  }

  async getBotUserId(): Promise<string | undefined> {
    if (!this.botUserIdPromise) {
      this.botUserIdPromise = this.slack.auth
        .test()
        .then((res) => (res as { user_id?: string }).user_id)
        .catch((error) => {
          this.botUserIdPromise = undefined;
          logger.warn('Unable to resolve Slack bot_user_id via auth.test', { error });
          return undefined;
        });
    }
    return this.botUserIdPromise;
  }

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

  async handleMessage(event: SlackMessageEvent): Promise<void> {
    const context = await buildMessageContext(this, event);
    if (!context) return;

    const {
      user,
      channel,
      text,
      threadTs,
      isDirectMessage,
      conversationId,
      requesterIdentity,
      history,
    } = context;

    const shortCircuitInput = {
      text,
      subtype: event.subtype,
      isDirectMessage,
      messageTs: event.ts,
    };
    if (
      await runStaticReply(this, {
        input: shortCircuitInput,
        history,
        channel,
        threadTs,
        conversationId,
        user,
      })
    ) {
      return;
    }

    const pendingEmail = await resolvePendingEmail(this, {
      text,
      channel,
      threadTs,
      user,
      conversationId,
      history,
    });
    if (pendingEmail.handled) return;

    const pendingStep = pendingOnboardingStep(history, isDirectMessage);

    if (
      await this.maybeAdvanceOnboarding({
        history,
        isDirectMessage,
        text,
        channel,
        threadTs,
        conversationId,
        user,
        employeeId: (await requesterIdentity).employeeId,
      })
    ) {
      return;
    }

    const acting = findActingReply(shortCircuitInput);

    if (acting) {
      switch (acting.action) {
        case 'erasure':
          return runErasure(this, {
            text,
            channel,
            threadTs,
            user,
            conversationId,
            isDirectMessage,
          });
        case 'pin_fact':
          return runPinFact(this, { text, channel, threadTs, user });
        case 'profile_form':
          return runProfileForm(this, {
            channel,
            threadTs,
            isDirectMessage,
            conversationId,
            user,
          });
        case 'cancel_reminder':
          return runCancelReminder(this, {
            text,
            channel,
            threadTs,
            conversationId,
            user,
            employeeId: (await requesterIdentity).employeeId,
          });
      }
    }

    const accessLevel = await enforceAuthorization(this, {
      user,
      channel,
      threadTs,
      isDirectMessage,
    });
    if (accessLevel === 'denied') return;

    if (isDirectMessage && user) {
      void this.getDirectoryRepo()
        ?.rememberDmChannel(user, channel)
        .catch((error) => logger.debug('Could not record the DM channel', { user, error }));
    }

    logger.info('Processing Slack message', { user, channel, textLength: text.length });

    void this.audit({
      action: AUDIT_ACTIONS.slackMessage,
      actorId: user ?? 'unknown',
      status: 'accepted',
      resourceType: 'SlackChannel',
      resourceId: channel,
      details: { accessLevel: accessLevel ?? 'not_evaluated', isDirectMessage },
    });

    if (!(await chargeModelBudget(this, user))) {
      await notifyRateLimited(this, channel, 'daily');
      return;
    }

    const progress = await startProgress(this.slack, { channel, threadTs });

    await runIntentChain(this, {
      event,
      text,
      channel,
      threadTs,
      user,
      conversationId,
      isDirectMessage,
      history,
      requesterIdentity,
      accessLevel,
      progress,
      pendingEmailReminder: pendingEmail.reminder,
      onboardingReminder: onboardingNudge(pendingStep, event.ts),
    });
  }
}

export * from './slack-event.types';

export type { SlackEventsHandlerOptions } from './handler-internals';

export { unwrapSanitizedInput } from './message-text';

export * from './response-notices';

export * from './onboarding-turn-state';

export { FILE_ATTACHMENT_REPLY } from '../../domain/services/deterministic-replies';

export {
  GENERIC_FAILURE,
  QUOTA_FAILURE,
  userFacingFailure,
} from '../../../../shared/user-facing-failure';

export {
  FOREIGN_TURN_PREFIX,
  buildContextPreamble,
  sanitizeDisplayName,
} from '../../domain/services/context-preamble';

export {
  UNSUPPORTED_CLAIM_NOTICE,
  PROMISED_DELIVERY_NOTICE,
  detectUnsupportedCompletionClaim,
  readToolCallNames,
} from '../../domain/services/claim-reconciliation';

export { buildProfileInviteBlocks, buildWelcomeBlocks } from '../ui/welcome-blocks';

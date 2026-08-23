import { WebClient } from '@slack/web-api';
import { LRUCache } from 'lru-cache';
import type { Mastra } from '@mastra/core';
import { judgeWorkspace } from '../../../../shared/slack-team';
import { logger } from '../../../../shared/logger';
import { wrapAgentInput } from '../../../../shared/security/llm-guardrail';
import { sanitizeAgentOutput } from '../../../../shared/security/agent-output';
import type { EmailBody } from '../../domain/services/email-body';
import {
  archiveIdOf,
  isArchivableChannelType,
  postedAtOf,
} from '../../../knowledge/domain/ports/message-archive.repository';
import type { KnowledgeIngestionPort } from '../../../knowledge/application/services/knowledge-ingestion.service';
import type { KnowledgeErasurePort } from '../../../knowledge/application/services/knowledge-erasure.service';
import { AGENT_GENERATE_TIMEOUT_MS } from '../../../../shared/llm/model-fallback';
import {
  describeModelResponse,
  MODEL_TRUNCATED_NOTICE,
} from '../../../../shared/llm/model-response';
import { SlackAdapter } from '../providers/slack.adapter';
import { SlackWorkspaceService } from '../providers/slack-workspace.service';
import type { SlackWorkspaceProvider } from '../../domain/ports/slack-workspace.port';
import {
  buildProfileInviteBlocks,
  buildWelcomeBlocks,
  firstWordOf,
  greet,
  restAfterFirstWord,
} from '../ui/welcome-blocks';
import {
  UNSUPPORTED_CLAIM_NOTICE,
  detectUnsupportedCompletionClaim,
  detectUnsupportedDeliveryPromise,
  promisesWithoutActing,
  PROMISED_DELIVERY_NOTICE,
  hasActingToolCall,
  readToolCallNames,
} from '../../domain/services/claim-reconciliation';
import {
  EMPTY_IDENTITY,
  FOREIGN_TURN_PREFIX,
  buildContextPreamble,
  sanitizeDisplayName,
  type RequesterIdentity,
} from '../../domain/services/context-preamble';
import {
  GENERIC_FAILURE,
  QUOTA_FAILURE,
  userFacingFailure,
} from '../../../../shared/user-facing-failure';
import { DEFAULT_AGENT_ID, routeToAgent } from '../../domain/services/agent-routing';
import {
  FILE_ATTACHMENT_REPLY,
  FILE_SHARE_SUBTYPE,
  findActingReply,
  findStaticReply,
  isAnsweredWithoutModel,
  replyFor,
} from '../../domain/services/deterministic-replies';
import { deriveConversationId } from '../../../conversation/domain/value-objects/conversation-id';
import {
  selectWindow,
  CONVERSATION_TOKEN_BUDGET,
} from '../../../conversation/domain/services/token-window';
import {
  CONVERSATION_TTL_MS,
  type ConversationRepository,
} from '../../../conversation/domain/ports/conversation.repository';
import type { ConversationTurn } from '../../../conversation/domain/entities/conversation-turn';
import { DrizzleConversationRepository } from '../../../conversation/infrastructure/repositories/drizzle-conversation.repository';
import { startProgress } from '../providers/slack-progress';
import {
  SLACK_EVENT_DEDUP_RETENTION_MS,
  type SlackEventDedupRepository,
} from '../../domain/ports/slack-event-dedup.repository';
import { DrizzleSlackEventDedupRepository } from '../repositories/drizzle-slack-event-dedup.repository';
import {
  buildSlackRequestContext,
  readExcerptCoverage,
  readAuthorizationNotice,
  readReminderDelivery,
  readDocumentRecipient,
  type SlackAccessLevel,
} from '../../../../shared/slack-request-context';
import { textMentionsName } from '../../../../shared/name-matching';
import { escalationName } from '../../../../shared/escalation';
import { SlackAccessGuard } from '../../../directory/application/services/access-guard';
import type { OnboardingInterviewRepository } from '../../../onboarding/domain/ports/onboarding-interview.repository';
import {
  PROFILE_CHECK_UNAVAILABLE,
  verifyProfile,
  type ProfileSnapshot,
} from '../../../onboarding/domain/services/profile-completion';
import {
  answersFromDirectory,
  PROFILE_ALREADY_COMPLETE,
  PROFILE_CHAT_SAVE_FAILED,
  PROFILE_QUESTIONS,
  answersFromRecord,
  captureProfileAnswer,
  collectProfileAnswers,
  nextProfileStep,
  pendingProfileStep,
  profileRetryReply,
  type ProfileAnswers,
  type ProfileStep,
} from '../../../onboarding/domain/services/profile-chat';
import {
  declaresTopRole,
  topRoleClaimNotice,
  topRoleClaimReply,
} from '../../../onboarding/domain/services/top-role-claim';
import {
  onboardingNudge,
  type PendingOnboardingStep,
} from '../../../onboarding/domain/services/onboarding-nudge';
import { runOnboarding } from '../../../onboarding/application/services/run-onboarding';
import type {
  PendingInterviewEmailRepository,
  PendingInterviewEmail,
} from '../../../recruitment/domain/ports/pending-email.repository';
import {
  confirmPendingEmail,
  pendingEmailVerdict,
  settlesPendingEmail,
  staleReply,
  ALREADY_SETTLED_REPLY,
  CANCELLED_REPLY,
  pendingReminder,
} from '../../../recruitment/application/services/confirm-pending-email';
import {
  startDateFromJoin,
  type NewcomerIdentity,
} from '../../../onboarding/domain/services/newcomer-identity';
import {
  INTERVIEW_QUESTION_DAILY,
  INTERVIEW_QUESTION_STYLE,
  INTERVIEW_SKIPPED_REPLY,
  interviewRetryReply,
  captureInterviewAnswer,
  isQuestionToBot,
  pendingInterviewStep,
  skipsInterview,
  type InterviewStep,
} from '../../../onboarding/domain/services/interview-chat';
import type { DirectoryRepository } from '../../../directory/domain/ports/directory.repository';
import type { WelcomeChannelsService } from '../../../directory/application/services/welcome-channels.service';
import { DrizzleDirectoryRepository } from '../../../directory/infrastructure/repositories/drizzle-directory.repository';
import { SlackMemberSource } from '../../../directory/infrastructure/providers/slack-member-source.adapter';
import { SlackRateLimiter } from '../services/slack-rate-limiter';
import {
  BURST_RULE,
  DAILY_RULE,
  WORKSPACE_TOKEN_RULE,
  readRuleLimit,
} from '../../domain/services/rate-limit-policy';
import { ERASURE_FAILED_REPLY, erasureDoneReply } from '../../../../shared/forget';
import {
  PROFILE_FORM_CHANNEL_REDIRECT,
  PROFILE_FORM_INVITE,
} from '../../../../shared/profile-request';
import {
  MAX_PINNED_FACTS,
  PIN_FAILED_REPLY,
  extractPinnedFact,
  pinnedFactReply,
} from '../../../../shared/pin-fact';
import type { PinnedFactRepository } from '../../../conversation/domain/ports/pinned-fact.repository';
import { DrizzlePinnedFactRepository } from '../../../conversation/infrastructure/repositories/drizzle-pinned-fact.repository';
import { DrizzleRateLimitRepository } from '../repositories/drizzle-rate-limit.repository';
import { writeAuditLog } from '../../../../infrastructure/audit/audit-log';
import { agentHasTool } from '../../../../shared/agent-capabilities';

export interface SlackMessageEvent {
  type?: string;
  subtype?: string;
  text?: string;
  user?: string;
  channel?: string;
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  app_id?: string;
  bot_profile?: unknown;
}

export interface SlackTeamJoinUser {
  id?: string;
  name?: string;
  real_name?: string;
  is_bot?: boolean;
  is_app_user?: boolean;
  is_workflow_bot?: boolean;
  deleted?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  is_stranger?: boolean;
  profile?: {
    email?: string;
    first_name?: string;
    last_name?: string;
    real_name?: string;
  };
}

export interface SlackTeamJoinEvent {
  type: 'team_join';
  user?: SlackTeamJoinUser;
  event_ts?: string;
}

export type SlackEvent = SlackTeamJoinEvent | SlackMessageEvent;

export function isTeamJoinEvent(event: SlackEvent): event is SlackTeamJoinEvent {
  return event.type === 'team_join';
}

export interface SlackEventEnvelope {
  type?: string;
  token?: string;
  challenge?: string;
  team_id?: string;
  api_app_id?: string;
  event_id?: string;
  event_time?: number;
  event?: SlackEvent;
}

export type SlackEventDecision =
  { action: 'process'; event: SlackEvent } | { action: 'ignore'; reason: SlackIgnoreReason };

export type SlackIgnoreReason =
  | 'not_event_callback'
  | 'no_event'
  | 'unsupported_event_type'
  | 'not_a_dm'
  | 'bot_message'
  | 'duplicate'
  | 'empty_text'
  | 'wrong_team'
  | 'no_user'
  | 'bot_join'
  | 'deleted_user'
  | 'restricted_user'
  | 'duplicate_mention'
  | 'stale_event'
  | 'rate_limited';

export interface SlackAcceptContext {
  retryNum?: string | null;
}

export interface SlackEventsHandlerOptions {
  slackClient?: WebClient;
  chatProvider?: Pick<SlackAdapter, 'sendBlocks'>;
  workspaceProvider?: Pick<SlackWorkspaceProvider, 'findUserById'>;
  dedupMax?: number;
  dedupTtlMs?: number;
  inFlightGraceMs?: number;
  conversationRepository?: ConversationRepository | null;
  pinnedFactRepository?: PinnedFactRepository | null;
  interviewRepository?: OnboardingInterviewRepository | null;
  profileRepository?: {
    findByEmail(email: string): Promise<ProfileSnapshot | null>;
    findById?(id: string): Promise<ProfileSnapshot | null>;
  } | null;
  dedupRepository?: SlackEventDedupRepository | null;
  conversationTokenBudget?: number;
  conversationTtlMs?: number;
  directoryRepository?: DirectoryRepository | null;
  welcomeChannels?: WelcomeChannelsService | null;
  accessGuard?: SlackAccessGuard | null;
  rateLimiter?: SlackRateLimiter | null;
  pruneProbability?: number;

  auditSink?: (entry: Parameters<typeof writeAuditLog>[0]) => Promise<unknown>;
  pendingEmailRepository?: PendingInterviewEmailRepository | null;
  sendEmail?: (to: string, subject: string, body: EmailBody) => Promise<unknown>;
  knowledgeIngestion?: KnowledgeIngestionPort | null;
  knowledgeErasure?: KnowledgeErasurePort | null;
  now?: () => Date;
}

type DedupStatus = 'in-flight' | 'done';

interface DedupEntry {
  status: DedupStatus;
  startedAt: number;
}

const DEFAULT_IN_FLIGHT_GRACE_MS = 60_000;

const DIRECTORY_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const SUPPORTED_EVENT_TYPES = new Set(['app_mention', 'message', 'team_join']);

export const SLACKBOT_USER_ID = 'USLACKBOT';

const CONVERSATION_QUERY_LIMIT = 40;

const DEFAULT_PRUNE_PROBABILITY = 0.2;

const MAX_EVENT_AGE_MS = 10 * 60 * 1000;

export function unwrapSanitizedInput(wrapped: string, fallback: string): string {
  const firstNewline = wrapped.indexOf('\n');
  const lastNewline = wrapped.lastIndexOf('\n');
  if (firstNewline < 0 || lastNewline <= firstNewline) return fallback;
  return wrapped.slice(firstNewline + 1, lastNewline);
}

function resolveThreadTarget(
  event: SlackMessageEvent,
  channel: string,
): { isDirectMessage: boolean; threadTs?: string } {
  const isDirectMessage = event.channel_type === 'im' || channel.startsWith('D');
  const isAlreadyThreaded = Boolean(event.thread_ts) && event.thread_ts !== event.ts;

  if (!isDirectMessage) return { isDirectMessage, threadTs: event.thread_ts ?? event.ts };
  return { isDirectMessage, threadTs: isAlreadyThreaded ? event.thread_ts : undefined };
}

const RATE_LIMIT_REPLIES: Readonly<Record<string, string>> = {
  workspaceTokens:
    "Le budget d'IA partagé de l'équipe est épuisé pour aujourd'hui. Il repart demain — " +
    'ce n’est pas ton quota à toi, et personne ne peut le relever en attendant.',
  daily:
    "Tu as atteint ta part du budget partagé pour aujourd'hui. Elle repart demain, et " +
    'elle est relevable — c’est un réglage de déploiement.',
  burst: 'Tu m’écris plus vite que je ne sais répondre. Laisse-moi une minute et reformule.',
};

interface MessageContext {
  readonly event: SlackMessageEvent;
  readonly user?: string;
  readonly channel: string;
  readonly text: string;
  readonly threadTs?: string;
  readonly isDirectMessage: boolean;
  readonly conversationId: string;
  readonly requesterIdentity: Promise<RequesterIdentity>;
  readonly history: ConversationTurn[];
}

function cancellationReply(cleared: number): string {
  if (cleared > 0) return CANCELLED_REPLY;
  if (cleared === 0) return ALREADY_SETTLED_REPLY;
  return 'Je n’ai pas réussi à annuler cet email — rien n’est parti pour autant. Redis-moi « non » dans un instant.';
}

function buildRecipientNotice(requestContext: unknown, answer: string): string {
  const recipient = readDocumentRecipient(requestContext);
  if (!recipient || textMentionsName(answer, recipient)) return '';
  return `\n\n_(Ce document a été produit pour ${recipient}.)_`;
}

function buildAuthorizationNotice(requestContext: unknown, answer: string): string {
  const notice = readAuthorizationNotice(requestContext);
  if (!notice) return '';
  if (textMentionsName(answer, escalationName())) return '';
  return `\n\n_(${notice})_`;
}

const CHANNEL_TOKEN = /<#C[^>]{1,140}>/i;

export function buildChannelRedirectNotice(text: string, agentId: string, answer: string): string {
  if (!CHANNEL_TOKEN.test(text)) return '';
  if (agentHasTool(agentId, 'getChannelHistory')) return '';
  if (/demande-moi (?:seulement |simplement )?le r[ée]sum[ée]/i.test(answer)) return '';

  return (
    '\n\n_(Pour un résumé de canal, demande-le seul — sans PDF ni email dans la même phrase. ' +
    'Je le lis alors moi-même, au lieu de te demander de me le recopier.)_'
  );
}

export function buildReminderNotice(requestContext: unknown, answer: string): string {
  const label = readReminderDelivery(requestContext);
  if (!label) return '';

  if (answer.includes(label) || /au matin\b/i.test(answer)) return '';

  const day = label.replace(/^le /i, '').replace(/ au matin$/i, '');
  if (answer.includes(day)) return "\n\n_(Au matin — je ne passe qu'une fois par jour.)_";

  return `\n\n_(Je te le remettrai ${label} — je ne passe qu'une fois par jour.)_`;
}

export class SlackEventsHandler {
  private slack: WebClient;
  private mastra: Mastra;
  private readonly seenEvents: LRUCache<string, DedupEntry>;
  private readonly inFlightGraceMs: number;
  private botUserIdPromise?: Promise<string | undefined>;
  private readonly chatProvider: Pick<SlackAdapter, 'sendBlocks'>;
  private readonly workspaceProvider: Pick<SlackWorkspaceProvider, 'findUserById'>;
  private teamIdWarningEmitted = false;
  private conversationRepo: ConversationRepository | null | undefined;
  private pinnedFactRepo: PinnedFactRepository | null | undefined;
  private readonly interviewRepo: OnboardingInterviewRepository | null | undefined;
  private readonly profileRepo:
    | {
        findByEmail(email: string): Promise<ProfileSnapshot | null>;
        findById?(id: string): Promise<ProfileSnapshot | null>;
      }
    | null
    | undefined;
  private dedupRepo: SlackEventDedupRepository | null | undefined;
  private readonly conversationTokenBudget: number;
  private readonly conversationTtlMs: number;
  private directoryRepo: DirectoryRepository | null | undefined;
  private readonly welcomeChannels: WelcomeChannelsService | null;
  private guard: SlackAccessGuard | null | undefined;
  private limiter: SlackRateLimiter | null | undefined;
  private readonly pruneProbability: number;
  private readonly requesterNames = new LRUCache<string, RequesterIdentity>({
    max: 500,
    ttl: 12 * 60 * 60 * 1000,
    allowStale: false,
  });

  private readonly botToken: string;

  private readonly audit: (entry: Parameters<typeof writeAuditLog>[0]) => Promise<unknown>;

  private readonly pendingEmailRepo: PendingInterviewEmailRepository | null | undefined;
  private readonly now: () => Date;
  private readonly knowledgeIngestion: KnowledgeIngestionPort | null | undefined;
  private readonly knowledgeErasure: KnowledgeErasurePort | null | undefined;
  private readonly sendEmail:
    ((to: string, subject: string, body: EmailBody) => Promise<unknown>) | undefined;

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

  private getDedupRepo(): SlackEventDedupRepository | null {
    if (this.dedupRepo === undefined) {
      this.dedupRepo = new DrizzleSlackEventDedupRepository();
    }
    return this.dedupRepo;
  }

  private getConversationRepo(): ConversationRepository | null {
    if (this.conversationRepo === undefined) {
      this.conversationRepo = new DrizzleConversationRepository();
    }
    return this.conversationRepo;
  }

  private getPinnedFactRepo(): PinnedFactRepository | null {
    if (this.pinnedFactRepo === undefined) {
      this.pinnedFactRepo = new DrizzlePinnedFactRepository();
    }
    return this.pinnedFactRepo;
  }

  routeToAgent(text: string, stickyAgentId?: string): string {
    return routeToAgent(text, stickyAgentId);
  }

  private getDirectoryRepo(): DirectoryRepository | null {
    if (this.directoryRepo === undefined) {
      this.directoryRepo = new DrizzleDirectoryRepository();
    }
    return this.directoryRepo;
  }

  private getAccessGuard(): SlackAccessGuard | null {
    if (this.guard === undefined) {
      const repo = this.getDirectoryRepo();
      const source = new SlackMemberSource(new SlackWorkspaceService(this.botToken));

      this.guard = repo
        ? new SlackAccessGuard({
            resolveSubject: async (slackUserId) => {
              const known = await repo.findBySlackUserId(slackUserId);

              if (known) {
                if (Date.now() - known.syncedAt.getTime() > DIRECTORY_STALE_AFTER_MS) {
                  void source
                    .findById(slackUserId)
                    .then((fresh) => (fresh ? repo.upsertFacts(fresh, new Date()) : undefined))
                    .catch((error) =>
                      logger.warn('Directory refresh failed — keeping the known facts', {
                        slackUserId,
                        error,
                      }),
                    );
                }

                return known;
              }

              const facts = await source.findById(slackUserId);
              if (!facts) return null;

              await repo.upsertFacts(facts, new Date()).catch((error) =>
                logger.warn('Could not persist the directory entry learned on the fly', {
                  slackUserId,
                  error,
                }),
              );

              return { ...facts, employeeId: null, isManager: false };
            },
            hasManager: () =>
              repo.hasManager().catch((error) => {
                logger.warn('Could not check for a designated manager', { error });
                return false;
              }),
          })
        : null;
    }
    return this.guard;
  }

  private getRateLimiter(): SlackRateLimiter | null {
    if (this.limiter === undefined) {
      this.limiter = new SlackRateLimiter({
        repository: new DrizzleRateLimitRepository(),
        rules: [
          { ...BURST_RULE, limit: readRuleLimit(process.env.SLACK_BURST_LIMIT, BURST_RULE.limit) },
          { ...DAILY_RULE, limit: readRuleLimit(process.env.SLACK_DAILY_LIMIT, DAILY_RULE.limit) },
        ],
        workspaceRule: {
          ...WORKSPACE_TOKEN_RULE,
          limit: readRuleLimit(
            process.env.SLACK_WORKSPACE_TOKEN_BUDGET,
            WORKSPACE_TOKEN_RULE.limit,
          ),
        },
      });
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

  private dedupKey(envelope: SlackEventEnvelope): string | undefined {
    const event = envelope.event;

    if (event && !isTeamJoinEvent(event)) {
      const { channel, ts } = event;
      if (channel && ts) return `ts:${channel}:${ts}`;
    }

    if (envelope.event_id) return `id:${envelope.event_id}`;
    return undefined;
  }

  async accept(
    envelope: SlackEventEnvelope,
    context: SlackAcceptContext = {},
  ): Promise<SlackEventDecision> {
    if (envelope.type !== 'event_callback') {
      return { action: 'ignore', reason: 'not_event_callback' };
    }

    const event = envelope.event;
    if (!event) {
      return { action: 'ignore', reason: 'no_event' };
    }

    if (!event.type || !SUPPORTED_EVENT_TYPES.has(event.type)) {
      return { action: 'ignore', reason: 'unsupported_event_type' };
    }

    const wrongTeam = this.checkTeamId(envelope);
    if (wrongTeam) return wrongTeam;

    const rejected = isTeamJoinEvent(event)
      ? this.rejectTeamJoin(event)
      : this.rejectMessage(event);
    if (rejected) return { action: 'ignore', reason: rejected };

    if (this.isStale(envelope, event)) {
      return { action: 'ignore', reason: 'stale_event' };
    }

    const key = this.dedupKey(envelope);
    if (key && !(await this.claimEvent(key, context.retryNum))) {
      return { action: 'ignore', reason: 'duplicate' };
    }

    const limited = await this.checkRateLimit(event);
    if (limited) return limited;

    return { action: 'process', event };
  }

  private isStale(envelope: SlackEventEnvelope, event: SlackEvent): boolean {
    if (isTeamJoinEvent(event)) return false;

    const emittedAtSeconds = envelope.event_time;
    if (!Number.isFinite(emittedAtSeconds) || (emittedAtSeconds ?? 0) <= 0) return false;

    const ageMs = Date.now() - (emittedAtSeconds as number) * 1000;
    if (ageMs < MAX_EVENT_AGE_MS) return false;

    logger.warn('Dropping a stale Slack event — answering it now would land out of context', {
      ageMs,
      channel: event.channel,
      type: event.type,
    });

    return true;
  }

  private isAnsweredWithoutModel(event: SlackEvent): boolean {
    if (isTeamJoinEvent(event)) return false;

    return isAnsweredWithoutModel({
      text: this.cleanText(event.text),
      subtype: event.subtype,
      isDirectMessage: event.channel_type === 'im' || (event.channel ?? '').startsWith('D'),
    });
  }

  private async checkRateLimit(event: SlackEvent): Promise<SlackEventDecision | null> {
    const limiter = this.getRateLimiter();
    if (!limiter) return null;

    const subject = isTeamJoinEvent(event) ? event.user?.id : event.user;
    if (!subject) return null;

    try {
      const decision = await limiter.check(subject, new Date(), {
        answeredWithoutModel: this.isAnsweredWithoutModel(event),
        reserveOnly: true,
      });
      if (decision.allowed) return null;

      if (decision.rationsModelBudget && (await this.settlesWithoutModel(event))) {
        logger.info('Rate limit waived: this message is answered without a model', {
          slackUserId: subject,
          rule: decision.rule,
        });
        return null;
      }

      logger.warn('Slack event dropped: rate limit exceeded', {
        slackUserId: subject,
        rule: decision.rule,
        degraded: decision.degraded,
      });

      void this.audit({
        action: 'RATE_LIMITED',
        actorId: subject,
        status: 'denied',
        details: { rule: decision.rule, degraded: decision.degraded },
      });

      if (decision.shouldNotify && !isTeamJoinEvent(event) && event.channel) {
        await this.notifyRateLimited(event.channel, decision.rule);
      }

      return { action: 'ignore', reason: 'rate_limited' };
    } catch (error) {
      logger.error('Rate limit check failed — letting the event through', { error });
      return null;
    }
  }

  private async chargeModelBudget(slackUserId: string | undefined): Promise<boolean> {
    if (!slackUserId) return true;
    const limiter = this.getRateLimiter();
    if (!limiter) return true;

    try {
      const claim = await limiter.claimModelBudget(slackUserId);
      if (!claim.allowed) {
        logger.warn('Model budget exhausted at claim time — message not served', { slackUserId });
      }
      return claim.allowed;
    } catch (error) {
      logger.error('Could not charge the model budget — serving the message anyway', { error });
      return true;
    }
  }

  private async settlesWithoutModel(event: SlackEvent): Promise<boolean> {
    if (isTeamJoinEvent(event) || !event.channel) return false;

    const { isDirectMessage, threadTs } = resolveThreadTarget(event, event.channel);
    const conversationId = deriveConversationId({ channel: event.channel, threadTs });
    const text = this.cleanText(event.text);

    try {
      const [history, pending] = await Promise.all([
        this.loadHistory(conversationId),
        this.pendingEmailRepo && this.sendEmail
          ? this.pendingEmailRepo.find(conversationId)
          : Promise.resolve(null),
      ]);

      if (answersOnboardingQuestion({ history, isDirectMessage, text })) return true;

      if (!pending) return false;

      return settlesPendingEmail(
        pendingEmailVerdict({
          pending,
          text,
          onboardingQuestionPending: hasPendingOnboardingQuestion(history),
          now: this.now(),
        }),
      );
    } catch (error) {
      logger.warn('Could not tell whether this message is answered without a model', {
        error: String(error),
      });
      return false;
    }
  }

  private async notifyRateLimited(channel: string, rule: string | null): Promise<void> {
    try {
      await this.slack.chat.postMessage({
        channel,
        text: (rule && RATE_LIMIT_REPLIES[rule]) || RATE_LIMIT_REPLIES.burst,
      });
    } catch (error) {
      logger.warn('Could not notify the user about the rate limit', { channel, error });
    }
  }

  private async claimEvent(key: string, retryNum?: string | null): Promise<boolean> {
    const local = this.claimLocally(key, retryNum);
    if (!local) return false;

    const repo = this.getDedupRepo();
    if (!repo) return true;

    try {
      const claim = await repo.claim(key, { inFlightGraceMs: this.inFlightGraceMs });

      if (!claim.granted) {
        this.seenEvents.delete(key);
        logger.info('Dropping duplicate Slack event (claimed by another instance)', {
          key,
          status: claim.status,
          ageMs: claim.ageMs,
          retryNum: retryNum ?? undefined,
        });
        return false;
      }

      if (claim.reclaimed) {
        logger.warn('Reprocessing an abandoned Slack event (shared claim)', {
          key,
          retryNum: retryNum ?? undefined,
        });
      }

      return true;
    } catch (error) {
      logger.error('Shared Slack dedup unavailable — falling back to the per-instance cache', {
        error,
        key,
        retryNum: retryNum ?? undefined,
      });
      return true;
    }
  }

  private claimLocally(key: string, retryNum?: string | null): boolean {
    const existing = this.seenEvents.get(key);

    if (existing) {
      const ageMs = Date.now() - existing.startedAt;
      const abandoned = existing.status === 'in-flight' && ageMs >= this.inFlightGraceMs;

      if (!abandoned) {
        logger.info('Dropping duplicate Slack event', {
          key,
          status: existing.status,
          ageMs,
          retryNum: retryNum ?? undefined,
        });
        return false;
      }

      logger.warn('Reprocessing abandoned Slack event', {
        key,
        ageMs,
        retryNum: retryNum ?? undefined,
      });
    }

    this.seenEvents.set(key, { status: 'in-flight', startedAt: Date.now() });
    return true;
  }

  private checkTeamId(envelope: SlackEventEnvelope): SlackEventDecision | undefined {
    const verdict = judgeWorkspace(envelope.team_id, process.env.SLACK_TEAM_ID);

    if (verdict.accepted) {
      if (!verdict.checked && !this.teamIdWarningEmitted) {
        this.teamIdWarningEmitted = true;
        logger.warn(
          'SLACK_TEAM_ID is not set — cross-workspace check disabled (fail-open by design)',
        );
      }
      return undefined;
    }

    logger.warn('Dropping Slack event from an unexpected workspace', {
      received: verdict.received,
      expected: verdict.expected,
    });
    return { action: 'ignore', reason: 'wrong_team' };
  }

  private rejectMessage(event: SlackMessageEvent): SlackIgnoreReason | undefined {
    if (event.type === 'message' && event.channel_type !== 'im') {
      const isThreadReply = Boolean(event.thread_ts) && event.thread_ts !== event.ts;
      if (!isThreadReply) return 'not_a_dm';
    }

    if (event.type === 'app_mention' && event.channel?.startsWith('D')) {
      return 'duplicate_mention';
    }

    if (event.bot_id || event.subtype === 'bot_message' || event.bot_profile) {
      return 'bot_message';
    }

    if (event.type === 'message' && event.subtype && event.subtype !== FILE_SHARE_SUBTYPE) {
      return 'unsupported_event_type';
    }

    if (event.subtype !== FILE_SHARE_SUBTYPE && !this.cleanText(event.text)) {
      return 'empty_text';
    }

    return undefined;
  }

  private rejectTeamJoin(event: SlackTeamJoinEvent): SlackIgnoreReason | undefined {
    const user = event.user;

    if (!user?.id) return 'no_user';

    if (user.is_bot || user.is_app_user || user.is_workflow_bot || user.id === SLACKBOT_USER_ID) {
      return 'bot_join';
    }

    if (user.deleted) return 'deleted_user';

    if (user.is_ultra_restricted || user.is_stranger) return 'restricted_user';

    return undefined;
  }

  private async markDedupDone(key: string | undefined): Promise<void> {
    if (!key) return;
    this.seenEvents.set(key, { status: 'done', startedAt: Date.now() });

    const repo = this.getDedupRepo();
    if (!repo) return;
    try {
      await repo.markDone(key);
    } catch (error) {
      logger.warn('Unable to mark the shared Slack dedup key as done', { error, key });
    }
  }

  private async releaseDedup(key: string | undefined): Promise<void> {
    if (!key) return;
    this.seenEvents.delete(key);

    const repo = this.getDedupRepo();
    if (!repo) return;
    try {
      await repo.release(key);
    } catch (error) {
      logger.warn('Unable to release the shared Slack dedup key', { error, key });
    }
  }

  private scheduleRateLimitPruneIfDue(): void {
    if (!this.pruneIsDue()) return;

    void this.getRateLimiter()?.pruneExpired();
  }

  private scheduleDedupPruneIfDue(): void {
    if (!this.pruneIsDue()) return;

    const repo = this.getDedupRepo();
    if (!repo) return;

    void repo
      .pruneOlderThan(new Date(Date.now() - SLACK_EVENT_DEDUP_RETENTION_MS))
      .then((removed) => logger.info('Pruned expired Slack dedup keys', { removed }))
      .catch((error) => logger.warn('Slack dedup prune failed', { error }));
  }

  private cleanText(text: string | undefined, botUserId?: string): string {
    // eslint-disable-next-line security/detect-non-literal-regexp
    const botMention = new RegExp(`<@${(botUserId ?? '').replace(/[^A-Z0-9]/gi, '')}>`, 'g');
    const mentions = botUserId ? botMention : /<@[A-Z0-9]+>/g;

    return (text ?? '').replace(mentions, ' ').replace(/\s+/g, ' ').trim();
  }

  private async resolveRequesterIdentity(
    slackUserId: string | undefined,
  ): Promise<RequesterIdentity> {
    if (!slackUserId) return EMPTY_IDENTITY;

    const cached = this.requesterNames.get(slackUserId);
    if (cached !== undefined) return cached;

    let resolved: RequesterIdentity = EMPTY_IDENTITY;

    try {
      const known = await this.getDirectoryRepo()?.findBySlackUserId(slackUserId);

      if (known) {
        resolved = {
          displayName: sanitizeDisplayName(
            known.realName || [known.firstName, known.lastName].filter(Boolean).join(' '),
          ),
          email: known.email,
          employeeId: known.employeeId,
        };
      }
    } catch (error) {
      logger.debug('Directory lookup failed while resolving the requester identity', {
        slackUserId,
        error,
      });
    }

    if (!resolved.displayName) {
      try {
        const member = await this.workspaceProvider.findUserById(slackUserId);
        resolved = {
          ...resolved,
          displayName: sanitizeDisplayName(
            member?.realName || [member?.firstName, member?.lastName].filter(Boolean).join(' '),
          ),
          email: resolved.email ?? member?.email ?? null,
        };
      } catch (error) {
        logger.debug('Unable to resolve the Slack display name — falling back to the user id', {
          slackUserId,
          error,
        });
      }
    }

    this.requesterNames.set(slackUserId, resolved);
    return resolved;
  }

  async ingest(envelope: SlackEventEnvelope): Promise<void> {
    const event = envelope.event;
    if (!event) return;
    await this.archiveChannelMessage(event);
  }

  async handleEvent(envelope: SlackEventEnvelope): Promise<void> {
    const key = this.dedupKey(envelope);
    try {
      await this.ingest(envelope);
      await this.processEvent(envelope);
      await this.markDedupDone(key);
    } catch (error) {
      await this.releaseDedup(key);
      throw error;
    }
  }

  private async processEvent(envelope: SlackEventEnvelope): Promise<void> {
    const event = envelope.event;
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
    const user = event.user;
    if (!user?.id) {
      logger.warn('team_join without a user id, skipping');
      return;
    }

    const joinedAt = new Date().toISOString();

    try {
      const identity = await this.resolveNewcomer(user);
      logger.info('Welcoming a newcomer', {
        userId: user.id,
        hasEmail: Boolean(identity.email),
      });

      await this.recordNewcomer(user.id, identity, joinedAt);
      const joinedNames = await this.inviteToWelcomeChannels(user.id);

      await this.chatProvider.sendBlocks(
        user.id,
        greet(identity.firstName ?? ''),
        buildWelcomeBlocks({ ...identity, joinedAt }, joinedNames),
      );
    } catch (error) {
      logger.error('Unable to send the welcome DM', { error, userId: user.id });
    }
  }

  private async recordNewcomer(
    slackUserId: string,
    identity: NewcomerIdentity,
    joinedAt: string,
  ): Promise<void> {
    const repo = this.getDirectoryRepo();
    if (!repo) return;

    const realName = [identity.firstName, identity.lastName].filter(Boolean).join(' ');

    try {
      await repo.upsertFacts(
        {
          slackUserId,
          teamId: '',
          email: identity.email ?? null,
          realName,
          displayName: realName,
          firstName: identity.firstName ?? null,
          lastName: identity.lastName ?? null,
          title: null,
          isBot: false,
          isAdmin: false,
          isRestricted: false,
          isUltraRestricted: false,
          isDeleted: false,
        },
        new Date(joinedAt),
      );
    } catch (error) {
      logger.error('Unable to record the newcomer in the directory', { error, slackUserId });
    }
  }

  private async inviteToWelcomeChannels(slackUserId: string): Promise<readonly string[]> {
    if (!this.welcomeChannels) return [];

    try {
      const report = await this.welcomeChannels.run(slackUserId);
      return report.joinedNames;
    } catch (error) {
      logger.error('Welcome channel invitations threw', { error, slackUserId });
      return [];
    }
  }

  private async resolveNewcomer(user: SlackTeamJoinUser): Promise<NewcomerIdentity> {
    const fromPayload: NewcomerIdentity = {
      slackUserId: user.id ?? '',
      firstName: user.profile?.first_name || firstWordOf(user.real_name),
      lastName: user.profile?.last_name || restAfterFirstWord(user.real_name),
      email: user.profile?.email ?? null,
    };

    if (fromPayload.email || !user.id) return fromPayload;

    try {
      const member = await this.workspaceProvider.findUserById(user.id);
      if (!member) return fromPayload;
      return {
        slackUserId: fromPayload.slackUserId,
        firstName: fromPayload.firstName || member.firstName,
        lastName: fromPayload.lastName || member.lastName,
        email: member.email,
      };
    } catch (error) {
      logger.warn('Directory lookup failed for a newcomer, continuing without email', {
        error,
        userId: user.id,
      });
      return fromPayload;
    }
  }

  private async runErasure(ctx: {
    text: string;
    channel: string;
    threadTs?: string;
    user?: string;
    conversationId: string;
    isDirectMessage: boolean;
  }): Promise<void> {
    const { channel, threadTs, user, conversationId, isDirectMessage } = ctx;
    const scope = isDirectMessage ? { conversationId } : { conversationId, slackUserId: user };

    const repo = this.getConversationRepo();

    if (!repo || (!isDirectMessage && !user)) {
      logger.warn('Erasure requested but the scope could not be established', {
        channel,
        hasRepo: Boolean(repo),
        isDirectMessage,
      });
      await this.slack.chat.postMessage({
        channel,
        text: ERASURE_FAILED_REPLY,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      return;
    }

    try {
      const removed = await repo.forget(scope);

      let removedFacts = 0;
      if (user) {
        try {
          removedFacts = (await this.getPinnedFactRepo()?.forget(user)) ?? 0;
        } catch (error) {
          logger.error('Pinned facts could not be erased', { error, channel });
        }
      }

      let removedArchive = 0;
      let archivePartial = false;
      if (isDirectMessage && user && this.knowledgeErasure) {
        const report = await this.knowledgeErasure.forget({
          slackUserId: user,
          channelId: channel,
        });
        removedArchive = report.messages + report.facts;
        archivePartial = report.partial;
      }

      logger.info('Erasure request honoured — answered without any LLM call', {
        channel,
        isDirectMessage,
        removed,
        removedFacts,
        removedArchive,
        archivePartial,
      });
      await this.slack.chat.postMessage({
        channel,
        text: archivePartial
          ? ERASURE_FAILED_REPLY
          : erasureDoneReply(removed + removedFacts + removedArchive),
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
    } catch (error) {
      logger.error('Erasure request failed', { error, channel });
      await this.slack.chat.postMessage({
        channel,
        text: ERASURE_FAILED_REPLY,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
    }
  }

  private async runPinFact(ctx: {
    text: string;
    channel: string;
    threadTs?: string;
    user?: string;
  }): Promise<void> {
    const { text, channel, threadTs, user } = ctx;
    const factToPin = extractPinnedFact(text);
    if (!factToPin) return;
    const repo = user ? this.getPinnedFactRepo() : null;

    if (!repo) {
      logger.warn('Pin requested but no long-term memory is available', {
        channel,
        hasUser: Boolean(user),
      });
      await this.slack.chat.postMessage({
        channel,
        text: PIN_FAILED_REPLY,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      return;
    }

    try {
      await repo.pin(
        {
          id: crypto.randomUUID(),
          slackUserId: user!,
          fact: factToPin,
          createdAt: new Date(),
        },
        MAX_PINNED_FACTS,
      );

      logger.info('Fact pinned — answered without any LLM call', {
        channel,
        factLength: factToPin.length,
      });

      await this.slack.chat.postMessage({
        channel,
        text: pinnedFactReply(factToPin),
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
    } catch (error) {
      logger.error('Pin request failed', { error, channel });
      await this.slack.chat.postMessage({
        channel,
        text: PIN_FAILED_REPLY,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
    }
  }

  private async runProfileForm(ctx: {
    channel: string;
    threadTs?: string;
    isDirectMessage: boolean;
    conversationId: string;
    user?: string;
  }): Promise<void> {
    const { channel, threadTs, isDirectMessage, conversationId, user } = ctx;
    if (!isDirectMessage) {
      logger.info('Profile form requested in a channel — redirected to DM, no LLM call', {
        channel,
      });
      await this.slack.chat.postMessage({
        channel,
        text: PROFILE_FORM_CHANNEL_REDIRECT,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      return;
    }

    const known = await this.knownProfileAnswers(user);
    const first = nextProfileStep(known);

    if (!first) {
      await this.sayAndRemember(
        { channel, threadTs, conversationId, user },
        PROFILE_ALREADY_COMPLETE,
      );
      return;
    }

    await this.chatProvider.sendBlocks(channel, PROFILE_FORM_INVITE, buildProfileInviteBlocks());

    await this.sayAndRemember(
      { channel, threadTs, conversationId, user },
      PROFILE_QUESTIONS[first],
    );

    logger.info('Profile form posted — answered without any LLM call', { channel, first });
  }

  private async runAgentPipeline(ctx: {
    event: SlackMessageEvent;
    text: string;
    channel: string;
    threadTs?: string;
    user?: string;
    conversationId: string;
    isDirectMessage: boolean;
    history: ConversationTurn[];
    requesterIdentity: Promise<RequesterIdentity>;
    accessLevel: SlackAccessLevel | undefined;
    progress: Awaited<ReturnType<typeof startProgress>>;
    pendingEmailReminder?: string;
    onboardingReminder?: string;
  }): Promise<void> {
    const {
      event,
      text,
      channel,
      threadTs,
      user,
      conversationId,
      history,
      requesterIdentity,
      accessLevel,
      progress,
      pendingEmailReminder,
      onboardingReminder,
    } = ctx;

    let phase: 'route' | 'resolve-agent' | 'wrap' | 'generate' | 'sanitize' | 'post' = 'route';
    let agentId = 'unknown';

    try {
      const stickyAgentId = history.at(-1)?.agentId;
      agentId = this.routeToAgent(text, stickyAgentId);
      logger.info('Routing to agent', {
        agentId,
        stickyAgentId: stickyAgentId ?? null,
        sticky: Boolean(stickyAgentId) && agentId === stickyAgentId,
        historyTurns: history.length,
      });

      phase = 'resolve-agent';
      const agent = this.tryGetAgent(agentId);
      if (!agent) {
        await progress.resolve(
          "Je n'arrive pas à traiter ta demande — c'est un problème de mon côté. Réessaie, et " +
            'si ça recommence, remonte-le.',
        );
        logger.error('Agent introuvable dans le registre Mastra', { agentId });
        return;
      }

      phase = 'wrap';
      const safeInput = wrapAgentInput(text);

      await this.rememberTurn({
        conversationId,
        role: 'user',
        content: unwrapSanitizedInput(safeInput, text),
        agentId,
        slackUserId: user ?? null,
      });

      phase = 'generate';
      const startedAt = Date.now();
      const identity = await requesterIdentity;

      const pinnedFacts = await this.loadPinnedFacts(user);

      const requestContext = buildSlackRequestContext({
        channel,
        threadTs,
        eventTs: event.ts,
        slackUserId: user,
        employeeId: identity.employeeId ?? undefined,
        accessLevel,
      });

      const response = await agent.generate(
        this.buildMessages(history, safeInput, {
          agentId,
          slackUserId: user,
          identity,
          pinnedFacts,
        }),
        {
          requestContext,
          abortSignal: AbortSignal.timeout(AGENT_GENERATE_TIMEOUT_MS),
        },
      );
      const durationMs = Date.now() - startedAt;

      phase = 'sanitize';
      const shape = describeModelResponse(response);
      const safeOutput = sanitizeAgentOutput(response.text);

      this.logSanitizerVerdicts(safeOutput, { agentId, channel });

      this.logResponseShape(shape, {
        agentId,
        channel,
        durationMs,
        steps: this.readSteps(response),
        length: safeOutput.text.length,
      });

      const toolCalls = readToolCallNames(response);
      const unsupportedClaim =
        toolCalls !== null && !hasActingToolCall(toolCalls)
          ? detectUnsupportedCompletionClaim(safeOutput.text)
          : null;

      if (unsupportedClaim) {
        logger.error('Agent claimed a completed action while no tool ran — response requalified', {
          agentId,
          channel,
          conversationId,
          claim: unsupportedClaim,
        });
      }

      const deliveryPromise =
        toolCalls !== null && promisesWithoutActing(toolCalls)
          ? detectUnsupportedDeliveryPromise(safeOutput.text)
          : null;

      if (deliveryPromise) {
        logger.error('Agent promised an automatic delivery that nothing performs', {
          agentId,
          channel,
          conversationId,
          claim: deliveryPromise,
        });
      }

      await this.rememberTurn({
        conversationId,
        role: 'assistant',
        content: safeOutput.text,
        agentId,
        slackUserId: null,
      });

      phase = 'post';
      const excerptCoverage = readExcerptCoverage(requestContext);

      const recipientNotice = buildRecipientNotice(requestContext, safeOutput.text);
      const authorizationNotice = buildAuthorizationNotice(requestContext, safeOutput.text);
      const reminderNotice = buildReminderNotice(requestContext, safeOutput.text);
      const channelRedirect = buildChannelRedirectNotice(text, agentId, safeOutput.text);

      await progress.resolve(
        safeOutput.text +
          (unsupportedClaim ? UNSUPPORTED_CLAIM_NOTICE : '') +
          (deliveryPromise ? PROMISED_DELIVERY_NOTICE : '') +
          recipientNotice +
          authorizationNotice +
          reminderNotice +
          channelRedirect +
          appendNotes([
            shape.truncated ? MODEL_TRUNCATED_NOTICE : undefined,
            excerptCoverage,
            pendingEmailReminder,
            onboardingReminder,
          ]),
      );

      const inputTokens = this.readInputTokens(response);

      logger.info('Slack response sent', {
        channel,
        agentId,
        conversationId,
        redacted: safeOutput.redacted.length,
        durationMs,
        steps: this.readSteps(response),
        inputTokens,
        toolCalls,
        unsupportedClaim,
        deliveryPromise,
      });

      void this.getRateLimiter()?.consumeTokens(inputTokens);

      this.schedulePruneIfDue();
      this.scheduleDedupPruneIfDue();
      this.scheduleRateLimitPruneIfDue();
    } catch (error) {
      logger.error('Error processing Slack message', {
        error,
        errorType: error instanceof Error ? error.constructor.name : typeof error,
        phase,
        agentId,
        conversationId,
        channel,
        textLength: text.length,
        user,
      });

      await progress.fail(userFacingFailure(error));
    }
  }

  private async enforceAuthorization(ctx: {
    user?: string;
    channel: string;
    threadTs?: string;
    isDirectMessage: boolean;
  }): Promise<SlackAccessLevel | undefined | 'denied'> {
    const { user, channel, threadTs, isDirectMessage } = ctx;
    const accessLevel = await this.evaluateAccess(user);

    if (accessLevel !== 'denied') return accessLevel;

    logger.warn('Slack message refused by the authorization policy', { user, channel });
    void this.audit({
      action: 'AUTHZ_DENIED',
      actorId: user ?? 'unknown',
      status: 'denied',
      details: { channel, isDirectMessage },
    });
    await this.slack.chat.postMessage({
      channel,
      text: "Je ne peux pas traiter cette demande. Rapproche-toi d'une personne de l'équipe.",
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    return 'denied';
  }

  private async buildMessageContext(event: SlackMessageEvent): Promise<MessageContext | null> {
    const { user, channel } = event;

    if (event.bot_id || event.subtype === 'bot_message') {
      logger.debug('Ignoring bot message', { botId: event.bot_id });
      return null;
    }

    if (!channel) {
      logger.warn('Slack event without channel, skipping', { user });
      return null;
    }

    const botUserId = await this.getBotUserId();
    const text = this.cleanText(event.text, botUserId);

    const { isDirectMessage, threadTs } = resolveThreadTarget(event, channel);

    const conversationId = deriveConversationId({ channel, threadTs });

    const requesterIdentity = this.resolveRequesterIdentity(user);

    const history = await this.loadHistory(conversationId);

    if (this.shouldAbandonThreadReply(event, isDirectMessage, history, botUserId)) {
      logger.info('Ignoring a channel thread reply: the bot has never spoken in this thread', {
        channel,
        threadTs,
        historyTurns: history.length,
      });
      return null;
    }

    return {
      event,
      user,
      channel,
      text,
      threadTs,
      isDirectMessage,
      conversationId,
      requesterIdentity,
      history,
    };
  }

  private async runStaticReply(ctx: {
    input: Parameters<typeof findStaticReply>[0];
    history: readonly ConversationTurn[];
    channel: string;
    threadTs: string | undefined;
    conversationId: string;
    user: string | undefined;
  }): Promise<boolean> {
    const { input, history, channel, threadTs, conversationId, user } = ctx;
    const staticReply = findStaticReply(input);
    const staticText = staticReply ? replyFor(staticReply, input) : null;

    if (staticReply && staticText) {
      logger.info(`Court-circuit deterministe (${staticReply.name}) — aucun appel de modele`, {
        channel,
        ...(staticReply.logFields?.(input) ?? {}),
      });

      await this.slack.chat.postMessage({
        channel,
        text: staticText,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });

      if (staticReply.remembersTurn && !hasPendingOnboardingQuestion(history)) {
        await this.rememberTurn({
          conversationId,
          role: 'user',
          content: input.text,
          agentId: DEFAULT_AGENT_ID,
          slackUserId: user ?? null,
        });
        await this.rememberTurn({
          conversationId,
          role: 'assistant',
          content: staticText,
          agentId: DEFAULT_AGENT_ID,
          slackUserId: null,
        });
      }
      return true;
    }

    return false;
  }

  private async resolvePendingEmail(input: {
    text: string;
    channel: string;
    threadTs: string | undefined;
    user: string | undefined;
    conversationId: string;
    history: readonly ConversationTurn[];
  }): Promise<{ handled: boolean; reminder?: string }> {
    const repo = this.pendingEmailRepo;
    const send = this.sendEmail;
    if (!repo || !send) return { handled: false };

    let pending: PendingInterviewEmail | null;
    try {
      pending = await repo.find(input.conversationId);
    } catch (error) {
      logger.error('Email d’entretien en attente illisible', { error: String(error) });
      return { handled: false };
    }
    if (!pending) return { handled: false };

    const verdict = pendingEmailVerdict({
      pending,
      text: input.text,
      onboardingQuestionPending: hasPendingOnboardingQuestion(input.history),
      now: this.now(),
    });

    if (verdict === 'stale') {
      await repo.clear(pending.conversationId).catch((error) => {
        logger.error('Préparation périmée non effacée', { error: String(error) });
        return 0;
      });
      logger.info('Email d’entretien abandonné — préparation périmée');
      return { handled: false, reminder: staleReply(pending) };
    }

    if (verdict === 'deferred') {
      return { handled: false, reminder: pendingReminder(pending) };
    }

    if (verdict === 'cancel') {
      const cleared = await repo.clear(pending.conversationId).catch((error) => {
        logger.error('Annulation d’email d’entretien échouée', { error: String(error) });
        return -1;
      });
      const reply = cancellationReply(cleared);
      await this.sayAndRemember(
        {
          channel: input.channel,
          threadTs: input.threadTs,
          conversationId: input.conversationId,
          user: input.user,
          text: input.text,
        },
        reply,
      );
      return { handled: true };
    }

    if (verdict === 'send') {
      const outcome = await confirmPendingEmail(
        { pending: repo, sendEmail: send },
        pending,
        input.user,
      );
      await this.sayAndRemember(
        {
          channel: input.channel,
          threadTs: input.threadTs,
          conversationId: input.conversationId,
          user: input.user,
          text: input.text,
        },
        outcome.reply,
      );
      return { handled: true };
    }

    return { handled: false, reminder: pendingReminder(pending) };
  }

  async handleMessage(event: SlackMessageEvent): Promise<void> {
    const context = await this.buildMessageContext(event);
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
      await this.runStaticReply({
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

    const pendingEmail = await this.resolvePendingEmail({
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
          return this.runErasure({
            text,
            channel,
            threadTs,
            user,
            conversationId,
            isDirectMessage,
          });
        case 'pin_fact':
          return this.runPinFact({ text, channel, threadTs, user });
        case 'profile_form':
          return this.runProfileForm({
            channel,
            threadTs,
            isDirectMessage,
            conversationId,
            user,
          });
      }
    }

    const accessLevel = await this.enforceAuthorization({
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
      action: 'SLACK_MESSAGE',
      actorId: user ?? 'unknown',
      status: 'accepted',
      resourceType: 'SlackChannel',
      resourceId: channel,
      details: { accessLevel: accessLevel ?? 'not_evaluated', isDirectMessage },
    });

    if (!(await this.chargeModelBudget(user))) {
      await this.notifyRateLimited(channel, 'daily');
      return;
    }

    const progress = await startProgress(this.slack, { channel, threadTs });
    await this.runAgentPipeline({
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

  private logSanitizerVerdicts(
    safeOutput: { redacted: string[]; strippedUrls: string[] },
    context: { agentId: string; channel: string },
  ): void {
    if (safeOutput.redacted.length > 0) {
      logger.error('Agent output carried internal markers — response replaced', {
        ...context,
        markers: safeOutput.redacted,
      });
    }

    if (safeOutput.strippedUrls.length > 0) {
      logger.error('Agent output carried fabricated links — links removed', {
        ...context,
        hosts: safeOutput.strippedUrls,
      });
    }
  }

  private shouldAbandonThreadReply(
    event: SlackMessageEvent,
    isDirectMessage: boolean,
    history: readonly ConversationTurn[],
    botUserId: string | undefined,
  ): boolean {
    if (event.type !== 'message' || isDirectMessage) return false;

    if (botUserId && (event.text ?? '').includes(`<@${botUserId}>`)) return false;

    if (!history.some((turn) => turn.role === 'assistant')) return true;

    return !history.some((turn) => turn.role === 'user' && turn.slackUserId === event.user);
  }

  private tryGetAgent(agentId: string) {
    try {
      return this.mastra.getAgent(agentId);
    } catch (error) {
      logger.error('Agent not found in the Mastra registry', { agentId, error });
      return undefined;
    }
  }

  private async maybeAdvanceOnboarding(input: {
    history: readonly ConversationTurn[];
    isDirectMessage: boolean;
    text: string;
    channel: string;
    threadTs: string | undefined;
    conversationId: string;
    user: string | undefined;
    employeeId: string | null | undefined;
  }): Promise<boolean> {
    if (await this.maybeCheckProfileDone(input)) return true;
    if (await this.maybeRunProfileStep(input)) return true;
    return await this.maybeRunInterviewStep(input);
  }

  private async maybeRunProfileStep(input: {
    history: readonly ConversationTurn[];
    isDirectMessage: boolean;
    text: string;
    channel: string;
    threadTs: string | undefined;
    conversationId: string;
    user: string | undefined;
  }): Promise<boolean> {
    if (!answersOnboardingQuestion(input)) return false;

    const step = pendingProfileStep(lastAssistantText(input.history));
    if (!step) return false;

    await this.runProfileStep({ ...input, step });
    return true;
  }

  private async runProfileStep(input: {
    step: ProfileStep;
    history: readonly ConversationTurn[];
    text: string;
    channel: string;
    threadTs: string | undefined;
    conversationId: string;
    user: string | undefined;
  }): Promise<void> {
    const { step, history, text, channel, user } = input;

    const value = captureProfileAnswer(step, text);
    if (!value) {
      await this.sayAndRemember(input, profileRetryReply(step));
      return;
    }

    const known = await this.knownProfileAnswers(user);
    const answers = { ...known, ...collectProfileAnswers(history), [step]: value };
    const next = nextProfileStep(answers);

    if (next) {
      logger.info(`Dossier en conversation (${step} reçu) — aucun appel de modele`, { channel });
      await this.sayAndRemember(input, PROFILE_QUESTIONS[next]);
      return;
    }

    logger.info('Dossier complet en conversation — lancement du workflow', { channel });
    await this.submitProfile(input, answers as Required<ProfileAnswers>);
  }

  private async knownProfileAnswers(user: string | undefined): Promise<ProfileAnswers> {
    if (!user) return {};
    try {
      const member = await this.getDirectoryRepo()?.findBySlackUserId(user);
      const fromDirectory = answersFromDirectory(member);
      const record = await this.findProfileRecord(member);
      return record ? { ...fromDirectory, ...answersFromRecord(record) } : fromDirectory;
    } catch (error) {
      logger.warn('Dossier existant illisible — la conversation repart de zéro', {
        error: String(error),
      });
      return {};
    }
  }

  private async findProfileRecord(
    member: { employeeId?: string | null; email?: string | null } | null | undefined,
  ): Promise<ProfileSnapshot | null> {
    if (!this.profileRepo) return null;

    const employeeId = member?.employeeId;
    if (employeeId && this.profileRepo.findById) {
      const byId = await this.profileRepo.findById(employeeId);
      if (byId) return byId;
    }

    const email = member?.email;
    return email ? await this.profileRepo.findByEmail(email) : null;
  }

  private async submitProfile(
    input: {
      channel: string;
      threadTs: string | undefined;
      conversationId: string;
      user: string | undefined;
    },
    answers: Required<ProfileAnswers>,
  ): Promise<void> {
    try {
      await runOnboarding(
        {
          getWorkflow: (key) => this.mastra.getWorkflow(key as never),
          notify: (text) => this.sayAndRemember(input, text),
          onRecordReady: async (employeeId) => {
            await this.linkRequesterToRecord(input.user, employeeId);
            const claim = await this.warnManagersOfTopRoleClaim(input.user, answers.position);
            if (claim) await this.sayAndRemember(input, claim);
            await this.sayAndRemember(input, INTERVIEW_QUESTION_DAILY);
          },
        },
        answers,
        startDateFromJoin(await this.joinedAtOf(input.user), new Date()),
      );
    } catch (error) {
      logger.error('Enregistrement du dossier en conversation impossible', {
        error: String(error),
      });
      await this.sayAndRemember(input, PROFILE_CHAT_SAVE_FAILED);
    }
  }

  private async warnManagersOfTopRoleClaim(
    slackUserId: string | undefined,
    position: string,
  ): Promise<string | null> {
    if (!slackUserId || !declaresTopRole(position)) return null;

    try {
      const repo = this.getDirectoryRepo();
      if (!repo) return null;

      const managers = (await repo.findManagers()).filter((m) => m.slackUserId !== slackUserId);

      if (managers.length === 0) {
        logger.warn('Poste au sommet déclaré, mais AUCUN manager à prévenir', {
          slackUserId,
          position,
        });
        return null;
      }

      const identity = await this.resolveRequesterIdentity(slackUserId);
      const notice = topRoleClaimNotice({
        newcomerName: identity.displayName ?? slackUserId,
        declaredPosition: position,
        slackUserId,
      });

      let informed = 0;
      for (const manager of managers) {
        try {
          await this.slack.chat.postMessage({ channel: manager.slackUserId, text: notice });
          informed += 1;
          logger.info('Manager prévenu d’une déclaration de poste au sommet', {
            managerId: manager.slackUserId,
          });
        } catch (error) {
          logger.error('DM au manager refusé — le déclarant ne doit pas croire l’inverse', {
            managerId: manager.slackUserId,
            error: String(error),
          });
        }
      }

      const holder = managers[0]!;
      return topRoleClaimReply({
        declaredPosition: position,
        holderName: sanitizeDisplayName(holder.displayName || holder.realName) || null,
        informed: informed > 0,
      });
    } catch (error) {
      logger.error('Impossible de prévenir le manager d’une déclaration de poste', {
        error: String(error),
      });
      return null;
    }
  }

  private async linkRequesterToRecord(
    slackUserId: string | undefined,
    employeeId: string | undefined,
  ): Promise<void> {
    if (!slackUserId || !employeeId) return;

    try {
      const linked = (await this.getDirectoryRepo()?.linkEmployee(slackUserId, employeeId)) ?? 0;
      this.requesterNames.delete(slackUserId);

      if (linked === 0) {
        logger.error('Annuaire NON relié — aucune ligne pour cette personne', {
          reason: 'no_directory_row',
          slackUserId,
          employeeId,
        });
        return;
      }

      logger.info('Annuaire relié au dossier', { slackUserId, employeeId });
    } catch (error) {
      logger.error('Annuaire NON relié — l’entretien et la frontière d’accès en dépendent', {
        slackUserId,
        employeeId,
        error: String(error),
      });
    }
  }

  private async joinedAtOf(slackUserId: string | undefined): Promise<string | undefined> {
    if (!slackUserId) return undefined;
    try {
      const member = await this.getDirectoryRepo()?.findBySlackUserId(slackUserId);
      return member?.firstSeenAt?.toISOString();
    } catch (error) {
      logger.debug('Date d’arrivée illisible — la création se poursuit', {
        error: String(error),
      });
      return undefined;
    }
  }

  private async sayAndRemember(
    input: {
      channel: string;
      threadTs: string | undefined;
      conversationId: string;
      user: string | undefined;
      text?: string;
    },
    reply: string,
  ): Promise<void> {
    await this.slack.chat.postMessage({
      channel: input.channel,
      text: reply,
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
    });

    if (input.text !== undefined) {
      await this.rememberTurn({
        conversationId: input.conversationId,
        role: 'user',
        content: input.text,
        agentId: DEFAULT_AGENT_ID,
        slackUserId: input.user ?? null,
      });
    }
    await this.rememberTurn({
      conversationId: input.conversationId,
      role: 'assistant',
      content: reply,
      agentId: DEFAULT_AGENT_ID,
      slackUserId: null,
    });
  }

  private async maybeCheckProfileDone(input: {
    history: readonly ConversationTurn[];
    isDirectMessage: boolean;
    text: string;
    channel: string;
    threadTs: string | undefined;
    conversationId: string;
    user: string | undefined;
  }): Promise<boolean> {
    const acting = findActingReply({ text: input.text, isDirectMessage: input.isDirectMessage });
    if (acting?.action !== 'profile_done') return false;

    await this.runProfileDoneCheck(input);
    return true;
  }

  private async runProfileDoneCheck(input: {
    history: readonly ConversationTurn[];
    text: string;
    channel: string;
    threadTs: string | undefined;
    conversationId: string;
    user: string | undefined;
  }): Promise<void> {
    const { history, text, channel, threadTs, conversationId, user } = input;

    let reply: string;
    try {
      const member = user ? await this.getDirectoryRepo()?.findBySlackUserId(user) : null;
      const record = await this.findProfileRecord(member);

      const known: ProfileAnswers = {
        ...answersFromDirectory(member),
        ...answersFromRecord(record),
        ...collectProfileAnswers(history),
      };

      const verdict = verifyProfile(record, known);

      if (record === null && nextProfileStep(known) === null) {
        await this.rememberTurn({
          conversationId,
          role: 'user',
          content: text,
          agentId: DEFAULT_AGENT_ID,
          slackUserId: user ?? null,
        });
        await this.submitProfile(
          { channel, threadTs, conversationId, user },
          known as Required<ProfileAnswers>,
        );
        return;
      }

      reply = verdict.reply;
    } catch (error) {
      logger.error('Vérification « j’ai fini » impossible — on ne l’impute pas à la personne', {
        error: String(error),
      });
      reply = PROFILE_CHECK_UNAVAILABLE;
    }

    logger.info('« J’ai fini » vérifié — aucun appel de modele', { channel });

    await this.slack.chat.postMessage({
      channel,
      text: reply,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });

    await this.rememberTurn({
      conversationId,
      role: 'user',
      content: text,
      agentId: DEFAULT_AGENT_ID,
      slackUserId: user ?? null,
    });
    await this.rememberTurn({
      conversationId,
      role: 'assistant',
      content: reply,
      agentId: DEFAULT_AGENT_ID,
      slackUserId: null,
    });
  }

  private async maybeRunInterviewStep(input: {
    history: readonly ConversationTurn[];
    isDirectMessage: boolean;
    text: string;
    channel: string;
    threadTs: string | undefined;
    conversationId: string;
    user: string | undefined;
    employeeId: string | null | undefined;
  }): Promise<boolean> {
    if (!answersOnboardingQuestion(input)) return false;

    const step = pendingInterviewStep(lastAssistantText(input.history));
    if (!step) return false;

    await this.runInterviewStep({ ...input, step });
    return true;
  }

  private async runInterviewStep(input: {
    step: InterviewStep;
    text: string;
    channel: string;
    threadTs: string | undefined;
    conversationId: string;
    user: string | undefined;
    employeeId: string | null | undefined;
  }): Promise<void> {
    const { step, text, channel, threadTs, conversationId, user } = input;

    const skipped = skipsInterview(text);
    const reply = interviewReplyFor(step, text, skipped);

    logger.info(`Entretien conversationnel (${step}) — aucun appel de modele`, {
      channel,
      skipped,
    });

    await this.slack.chat.postMessage({
      channel,
      text: reply,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });

    await this.rememberTurn({
      conversationId,
      role: 'user',
      content: text,
      agentId: DEFAULT_AGENT_ID,
      slackUserId: user ?? null,
    });
    await this.rememberTurn({
      conversationId,
      role: 'assistant',
      content: reply,
      agentId: DEFAULT_AGENT_ID,
      slackUserId: null,
    });

    await this.persistInterviewAnswer(input, skipped);
  }

  private async persistInterviewAnswer(
    input: {
      step: InterviewStep;
      text: string;
      employeeId: string | null | undefined;
      user: string | undefined;
    },
    skipped: boolean,
  ): Promise<void> {
    const answer = skipped ? null : captureInterviewAnswer(input.text);
    if (!answer || !this.interviewRepo || !input.user) return;

    if (!input.employeeId) {
      logger.error('Réponse d’entretien PERDUE — annuaire non relié au dossier', {
        reason: 'missing_employee_id',
        slackUserId: input.user,
        step: input.step,
      });
      return;
    }

    try {
      const existing = await this.interviewRepo.findByEmployee(input.employeeId);
      const now = new Date();
      await this.interviewRepo.save({
        employeeId: input.employeeId,
        slackUserId: input.user,
        channels: existing?.channels ?? [],
        dailyWork: input.step === 'dailyWork' ? answer : (existing?.dailyWork ?? ''),
        workStyle: input.step === 'workStyle' ? answer : (existing?.workStyle ?? ''),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
    } catch (error) {
      logger.error('Réponse d’entretien non persistée — la conversation, elle, a abouti', {
        error: String(error),
        step: input.step,
      });
    }
  }

  private async loadHistory(conversationId: string): Promise<ConversationTurn[]> {
    const repo = this.getConversationRepo();
    if (!repo) return [];

    try {
      return await repo.findRecentTurns(conversationId, {
        ttlMs: this.conversationTtlMs,
        limit: CONVERSATION_QUERY_LIMIT,
      });
    } catch (error) {
      logger.warn('Unable to load conversation history — continuing without memory', {
        error,
        conversationId,
      });
      return [];
    }
  }

  private async loadPinnedFacts(slackUserId: string | undefined): Promise<readonly string[]> {
    if (!slackUserId) return [];

    const repo = this.getPinnedFactRepo();
    if (!repo) return [];

    try {
      const facts = await repo.list(slackUserId, MAX_PINNED_FACTS);
      return facts.map((entry) => entry.fact);
    } catch (error) {
      logger.error('Long-term memory unavailable — continuing without pinned facts', { error });
      return [];
    }
  }

  private async rememberTurn(turn: {
    conversationId: string;
    role: 'user' | 'assistant';
    content: string;
    agentId: string;
    slackUserId: string | null;
  }): Promise<void> {
    const repo = this.getConversationRepo();
    if (!repo) return;

    try {
      await repo.append(turn);
    } catch (error) {
      logger.warn('Unable to persist a conversation turn', {
        error,
        conversationId: turn.conversationId,
        role: turn.role,
      });
    }
  }

  private buildMessages(
    history: readonly ConversationTurn[],
    wrappedCurrentInput: string,
    context: {
      agentId: string;
      slackUserId?: string;
      identity: RequesterIdentity;
      pinnedFacts?: readonly string[];
    },
  ) {
    const window = selectWindow(history, this.conversationTokenBudget);

    const preamble = buildContextPreamble({
      slackUserId: context.slackUserId,
      displayName: context.identity.displayName,
      email: context.identity.email,
      employeeId: context.identity.employeeId,
      pinnedFacts: context.pinnedFacts,
      now: this.now(),
      hasForeignTurns: window.some(
        (turn) => turn.role === 'assistant' && turn.agentId !== context.agentId,
      ),
    });

    const replayed = window.map((turn) =>
      turn.role === 'assistant'
        ? ({
            role: 'assistant',
            content:
              turn.agentId === context.agentId ? turn.content : FOREIGN_TURN_PREFIX + turn.content,
          } as const)
        : ({ role: 'user', content: turn.content } as const),
    );

    const preambleMessages = preamble ? [{ role: 'system', content: preamble } as const] : [];

    return [
      ...preambleMessages,
      ...replayed,
      { role: 'user', content: wrappedCurrentInput } as const,
    ];
  }

  private pruneIsDue(): boolean {
    if (this.pruneProbability <= 0) return false;
    if (this.pruneProbability >= 1) return true;
    // eslint-disable-next-line sonarjs/pseudo-random
    return Math.random() < this.pruneProbability;
  }

  private schedulePruneIfDue(): void {
    if (!this.pruneIsDue()) return;

    const repo = this.getConversationRepo();
    if (!repo) return;

    void repo
      .pruneOlderThan(new Date(Date.now() - this.conversationTtlMs))
      .then((removed) => logger.info('Pruned expired conversation turns', { removed }))
      .catch((error) => logger.warn('Conversation prune failed', { error }));
  }

  private logResponseShape(
    shape: { empty: boolean; truncated: boolean },
    context: {
      agentId: string;
      channel: string;
      durationMs: number;
      steps: number | null;
      length: number;
    },
  ): void {
    const { agentId, channel, durationMs, steps, length } = context;

    if (shape.empty) {
      logger.error('Le modèle n’a rien produit — refus neutre rendu par défaut', {
        agentId,
        channel,
        durationMs,
        steps,
      });
    }

    if (shape.truncated) {
      logger.warn('Réponse coupée par le plafond de sortie du fournisseur', {
        agentId,
        channel,
        length,
      });
    }
  }

  private readSteps(response: unknown): number | null {
    const steps = (response as { steps?: unknown }).steps;
    return Array.isArray(steps) ? steps.length : null;
  }

  private readInputTokens(response: unknown): number | null {
    const usage = (response as { usage?: { inputTokens?: unknown } }).usage;
    return typeof usage?.inputTokens === 'number' ? usage.inputTokens : null;
  }

  private noAccessGuardLogged = false;

  private warnNoAccessGuardOnce(): void {
    if (this.noAccessGuardLogged) return;
    this.noAccessGuardLogged = true;
    logger.error(
      'No access guard is wired (directoryRepository missing) — authorization cannot be ' +
        "evaluated. Nobody will be able to read anyone else's record.",
    );
  }

  private async archiveChannelMessage(event: SlackEvent): Promise<void> {
    const ingestion = this.knowledgeIngestion;
    if (!ingestion || isTeamJoinEvent(event)) return;

    const message = event as SlackMessageEvent;
    if (!isArchivableChannelType(message.channel_type)) return;
    if (message.bot_id || message.subtype === 'bot_message') return;

    const text = (message.text ?? '').trim();
    if (!text || !message.channel || !message.ts) return;

    try {
      await ingestion.ingest({
        id: archiveIdOf(message.channel, message.ts),
        channelId: message.channel,
        slackUserId: message.user ?? null,
        text,
        threadTs: message.thread_ts ?? null,
        postedAt: postedAtOf(message.ts),
      });
    } catch (error) {
      logger.warn('Message non archivé — la connaissance dégrade, le bot répond', {
        channel: message.channel,
        error: String(error),
      });
    }
  }

  private async evaluateAccess(user: string | undefined): Promise<SlackAccessLevel | undefined> {
    if (!user) return undefined;

    const guard = this.getAccessGuard();
    if (!guard) {
      this.warnNoAccessGuardOnce();
      return undefined;
    }

    try {
      const evaluation = await guard.evaluate(user);
      return evaluation.effective;
    } catch (error) {
      logger.error('Access evaluation failed — falling back to no evaluation', { user, error });
      return undefined;
    }
  }
}

export { FILE_ATTACHMENT_REPLY };

export { GENERIC_FAILURE, QUOTA_FAILURE, userFacingFailure };

export { FOREIGN_TURN_PREFIX, buildContextPreamble, sanitizeDisplayName };

export {
  UNSUPPORTED_CLAIM_NOTICE,
  PROMISED_DELIVERY_NOTICE,
  detectUnsupportedCompletionClaim,
  readToolCallNames,
};

export { buildProfileInviteBlocks, buildWelcomeBlocks };

function appendNotes(notes: readonly (string | undefined)[]): string {
  const present = notes.filter((note): note is string => Boolean(note));
  return present.length === 0 ? '' : `\n\n${present.join('\n\n')}`;
}

export function pendingOnboardingStep(
  history: readonly ConversationTurn[],
  isDirectMessage: boolean,
): PendingOnboardingStep | undefined {
  if (!isDirectMessage) return undefined;

  const last = lastAssistantText(history);

  const profile = pendingProfileStep(last);
  if (profile) return { kind: 'profile', step: profile };

  const interview = pendingInterviewStep(last);
  if (interview) return { kind: 'interview', step: interview };

  return undefined;
}

export function answersOnboardingQuestion(input: {
  readonly history: readonly ConversationTurn[];
  readonly isDirectMessage: boolean;
  readonly text: string;
}): boolean {
  if (!input.isDirectMessage) return false;
  if (!hasPendingOnboardingQuestion(input.history)) return false;
  if (findActingReply({ text: input.text, isDirectMessage: true })) return false;
  return !isQuestionToBot(input.text);
}

export function hasPendingOnboardingQuestion(history: readonly ConversationTurn[]): boolean {
  const last = lastAssistantText(history);
  return pendingProfileStep(last) !== null || pendingInterviewStep(last) !== null;
}

export function lastAssistantText(history: readonly ConversationTurn[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i]!;
    if (turn.role === 'assistant') return turn.content;
  }
  return undefined;
}

export function interviewReplyFor(step: InterviewStep, text: string, skipped: boolean): string {
  if (skipped) return INTERVIEW_SKIPPED_REPLY;

  const answer = captureInterviewAnswer(text);
  if (!answer) return interviewRetryReply(step);
  if (step === 'dailyWork') return INTERVIEW_QUESTION_STYLE;
  return interviewDoneReply(answer);
}

export function interviewDoneReply(workStyle: string): string {
  const echo = workStyle.length > 60 ? `${workStyle.slice(0, 60)}…` : workStyle;
  return (
    `Compris — ${echo}. C’est tout ce dont j’avais besoin. Demande-moi ton guide d’accueil ` +
    'quand tu veux, j’y mettrai ce que tu viens de me dire.'
  );
}

import { WebClient } from '@slack/web-api';
import { LRUCache } from 'lru-cache';
import type { Mastra } from '@mastra/core';
import { logger } from '../../../../shared/logger';
import { routeToAgent } from '../../domain/services/agent-routing';
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
import type { SlackEventDedupRepository } from '../../domain/ports/slack-event-dedup.repository';
import { DrizzleSlackEventDedupRepository } from '../repositories/drizzle-slack-event-dedup.repository';
import { SlackRateLimiter } from '../services/slack-rate-limiter';
import { writeAuditLog } from '../../../../infrastructure/audit/audit-log';
import type { RequesterIdentity } from '../../domain/services/context-preamble';
import type { OnboardingInterviewRepository } from '../../../onboarding/domain/ports/onboarding-interview.repository';
import type { PendingInterviewEmailRepository } from '../../../recruitment/domain/ports/pending-email.repository';
import type { KnowledgeIngestionPort } from '../../../knowledge/application/services/knowledge-ingestion.service';
import type { KnowledgeErasurePort } from '../../../knowledge/application/services/knowledge-erasure.service';
import type { NotificationRepository } from '../../domain/ports/notification.repository';
import type {
  AuditSink,
  DedupEntry,
  ProfileRepositoryPort,
  SendEmailPort,
  SlackEventsHandlerOptions,
} from './handler-internals';
import { DEFAULT_PRUNE_PROBABILITY } from './conversation-memory';
import { DEFAULT_IN_FLIGHT_GRACE_MS } from './event-dedup';
import { buildAccessGuard } from './access-guard.factory';
import { buildRateLimiter } from './rate-limiter.factory';

export class SlackHandlerCore {
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
}

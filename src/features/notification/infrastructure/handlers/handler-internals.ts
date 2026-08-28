import type { WebClient } from '@slack/web-api';
import type { LRUCache } from 'lru-cache';
import type { Mastra } from '@mastra/core';
import type { EmailBody } from '../../domain/services/email-body';
import type { KnowledgeIngestionPort } from '../../../knowledge/application/services/knowledge-ingestion.service';
import type { KnowledgeErasurePort } from '../../../knowledge/application/services/knowledge-erasure.service';
import type { SlackAdapter } from '../providers/slack.adapter';
import type { SlackWorkspaceProvider } from '../../domain/ports/slack-workspace.port';
import type { RequesterIdentity } from '../../domain/services/context-preamble';
import type { ConversationRepository } from '../../../conversation/domain/ports/conversation.repository';
import type { ConversationTurn } from '../../../conversation/domain/entities/conversation-turn';
import type { SlackEventDedupRepository } from '../../domain/ports/slack-event-dedup.repository';
import type { SlackAccessLevel } from '../../../../shared/slack-request-context';
import type { SlackAccessGuard } from '../../../directory/application/services/access-guard';
import type { OnboardingInterviewRepository } from '../../../onboarding/domain/ports/onboarding-interview.repository';
import type { ProfileSnapshot } from '../../../onboarding/domain/services/profile-completion';
import type { PendingInterviewEmailRepository } from '../../../recruitment/domain/ports/pending-email.repository';
import type { DirectoryRepository } from '../../../directory/domain/ports/directory.repository';
import type { WelcomeChannelsService } from '../../../directory/application/services/welcome-channels.service';
import type { SlackRateLimiter } from '../services/slack-rate-limiter';
import type { PinnedFactRepository } from '../../../conversation/domain/ports/pinned-fact.repository';
import type { NotificationRepository } from '../../domain/ports/notification.repository';
import type { writeAuditLog } from '../../../../infrastructure/audit/audit-log';
import type { startProgress } from '../providers/slack-progress';
import type { SlackMessageEvent } from './slack-event.types';

export type ProfileRepositoryPort = {
  findByEmail(email: string): Promise<ProfileSnapshot | null>;
  findById?(id: string): Promise<ProfileSnapshot | null>;
};

export type AuditSink = (entry: Parameters<typeof writeAuditLog>[0]) => Promise<unknown>;

export type SendEmailPort = (to: string, subject: string, body: EmailBody) => Promise<unknown>;

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
  profileRepository?: ProfileRepositoryPort | null;
  dedupRepository?: SlackEventDedupRepository | null;
  conversationTokenBudget?: number;
  conversationTtlMs?: number;
  directoryRepository?: DirectoryRepository | null;
  welcomeChannels?: WelcomeChannelsService | null;
  accessGuard?: SlackAccessGuard | null;
  rateLimiter?: SlackRateLimiter | null;
  pruneProbability?: number;

  auditSink?: AuditSink;
  pendingEmailRepository?: PendingInterviewEmailRepository | null;
  sendEmail?: SendEmailPort;
  knowledgeIngestion?: KnowledgeIngestionPort | null;
  knowledgeErasure?: KnowledgeErasurePort | null;
  notificationRepository?: NotificationRepository | null;
  now?: () => Date;
}

export type DedupStatus = 'in-flight' | 'done';

export interface DedupEntry {
  status: DedupStatus;
  startedAt: number;
}

export type StepOutcome = 'served' | 'blocked';

export type AgentTurnPhase = 'route' | 'resolve-agent' | 'wrap' | 'generate' | 'sanitize' | 'post';

export interface AgentTurnState {
  phase: AgentTurnPhase;
  agentId: string;
  startedAt: number;
}

export interface MessageContext {
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

export interface AgentPipelineContext {
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
}

export interface SlackHandlerInternals {
  readonly slack: WebClient;
  readonly mastra: Mastra;
  readonly chatProvider: Pick<SlackAdapter, 'sendBlocks'>;
  readonly workspaceProvider: Pick<SlackWorkspaceProvider, 'findUserById'>;
  readonly seenEvents: LRUCache<string, DedupEntry>;
  readonly requesterNames: LRUCache<string, RequesterIdentity>;
  readonly inFlightGraceMs: number;
  readonly conversationTokenBudget: number;
  readonly conversationTtlMs: number;
  readonly pruneProbability: number;
  readonly welcomeChannels: WelcomeChannelsService | null;
  readonly interviewRepo: OnboardingInterviewRepository | null | undefined;
  readonly profileRepo: ProfileRepositoryPort | null | undefined;
  readonly pendingEmailRepo: PendingInterviewEmailRepository | null | undefined;
  readonly notificationRepo: NotificationRepository | null | undefined;
  readonly knowledgeIngestion: KnowledgeIngestionPort | null | undefined;
  readonly knowledgeErasure: KnowledgeErasurePort | null | undefined;
  readonly sendEmail: SendEmailPort | undefined;
  readonly audit: AuditSink;
  readonly now: () => Date;
  teamIdWarningEmitted: boolean;
  noAccessGuardLogged: boolean;
  getDedupRepo(): SlackEventDedupRepository | null;
  getConversationRepo(): ConversationRepository | null;
  getPinnedFactRepo(): PinnedFactRepository | null;
  getDirectoryRepo(): DirectoryRepository | null;
  getAccessGuard(): SlackAccessGuard | null;
  getRateLimiter(): SlackRateLimiter | null;
  getBotUserId(): Promise<string | undefined>;
  routeToAgent(text: string, stickyAgentId?: string): string;
  runAgentPipeline(ctx: AgentPipelineContext): Promise<StepOutcome>;
}

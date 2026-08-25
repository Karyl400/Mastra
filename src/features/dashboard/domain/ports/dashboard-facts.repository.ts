export interface FeedEntry {
  readonly at: number;
  readonly kind: 'user' | 'assistant' | 'audit';
  readonly agentId: string | null;
  readonly action: string | null;
  readonly conversationRef: string;
  readonly length: number;
}

export interface DashboardFacts {
  readonly directoryPeople: number;
  readonly directoryLinked: number;
  readonly employeeRecords: number;
  readonly progressCompleted: number;
  readonly interviewsFilled: number;
  readonly completionDurationsMs: readonly number[];

  readonly userTurns: number;
  readonly assistantTurns: number;
  readonly assistantTurnsFollowedByUser: number;
  readonly assistantTurnsAnswerable: number;
  readonly distinctUsers: number;
  readonly humanReplyDelaysMs: readonly number[];

  readonly modelHandledMessages: number;
  readonly agentRuns: number;
  readonly agentRunsFailed: number;
  readonly requalifiedResponses: number;
  readonly latenciesMs: readonly number[];
  readonly toolCallCounts: Readonly<Record<string, number>>;

  readonly notificationsTotal: number;
  readonly notificationsFailed: number;
  readonly documentsTotal: number;
  readonly documentsDelivered: number;
  readonly auditFailures: number;
  readonly rateLimited: number;

  readonly activeUsers: number;
  readonly openConversations: number;
  readonly feed: readonly FeedEntry[];

  readonly unreadableTables: readonly string[];
}

export function tableOf(sourceLabel: string): string {
  return (sourceLabel.split(/[\s(.]/)[0] ?? '').trim();
}

export interface DashboardFactsRepository {
  readFacts(now: Date): Promise<DashboardFacts>;
}

export const WINDOW_HOURS = 24;

export const LIVE_WINDOW_MS = 60 * 60 * 1000;

export const FEED_SIZE = 40;

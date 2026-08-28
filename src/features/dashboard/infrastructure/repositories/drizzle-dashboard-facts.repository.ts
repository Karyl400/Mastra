import { getDb, type DatabaseInstance } from '../../../../infrastructure/database/connection';
import {
  LIVE_WINDOW_MS,
  WINDOW_HOURS,
  type DashboardFacts,
  type DashboardFactsRepository,
  type FeedEntry,
} from '../../domain/ports/dashboard-facts.repository';
import { fingerprint, num, summariseRuns } from './dashboard-fact-readers';
import { readDashboardRows } from './dashboard-fact-queries';

export class DrizzleDashboardFactsRepository implements DashboardFactsRepository {
  constructor(private readonly resolveDb: () => DatabaseInstance = getDb) {}

  async readFacts(now: Date): Promise<DashboardFacts> {
    const db = this.resolveDb();
    const since = now.getTime() - WINDOW_HOURS * 60 * 60 * 1000;
    const liveSince = now.getTime() - LIVE_WINDOW_MS;
    const unreadable: string[] = [];

    const {
      people,
      records,
      progress,
      durations,
      interviews,
      turns,
      pairs,
      audit,
      runs,
      notif,
      docs,
      feed,
    } = await readDashboardRows(db, since, liveSince, unreadable);

    return {
      directoryPeople: num(people[0]?.total),
      directoryLinked: num(people[0]?.linked),
      employeeRecords: num(records[0]?.total),
      progressCompleted: num(progress[0]?.completed),
      interviewsFilled: num(interviews[0]?.total),
      completionDurationsMs: durations.map((row) => num(row.duration_ms)).filter((ms) => ms >= 0),

      userTurns: num(turns[0]?.user_turns),
      assistantTurns: num(turns[0]?.assistant_turns),
      assistantTurnsFollowedByUser: pairs.filter((row) => num(row.answered) === 1).length,
      assistantTurnsAnswerable: pairs.length,
      distinctUsers: num(turns[0]?.distinct_users),
      humanReplyDelaysMs: pairs
        .map((row) => row.delay_ms)
        .filter((ms): ms is number => typeof ms === 'number' && ms >= 0),

      modelHandledMessages: num(audit[0]?.model_handled),
      ...summariseRuns(runs),

      notificationsTotal: num(notif[0]?.total),
      notificationsFailed: num(notif[0]?.failed),
      documentsTotal: num(docs[0]?.total),
      documentsDelivered: num(docs[0]?.delivered),
      auditFailures: num(audit[0]?.failures),
      rateLimited: num(audit[0]?.rate_limited),

      activeUsers: num(turns[0]?.active_users),
      openConversations: num(turns[0]?.open_conversations),

      unreadableTables: unreadable,
      feed: feed.map((row): FeedEntry => ({
        at: num(row.at),
        kind: row.role === 'user' ? 'user' : 'assistant',
        agentId: row.agent_id ?? null,
        action: null,
        conversationRef: fingerprint(String(row.conversation_id ?? '')),
        length: num(row.len),
      })),
    };
  }
}

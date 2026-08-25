import { sql } from 'drizzle-orm';

import { getDb, type DatabaseInstance } from '../../../../infrastructure/database/connection';
import { logger } from '../../../../shared/logger';
import { AUDIT_ACTIONS } from '../../../../shared/audit-actions';
import {
  FEED_SIZE,
  LIVE_WINDOW_MS,
  WINDOW_HOURS,
  type DashboardFacts,
  type DashboardFactsRepository,
  type FeedEntry,
} from '../../domain/ports/dashboard-facts.repository';

const WINDOW = `-${WINDOW_HOURS} hours`;

const SAMPLE_CAP = 500;

async function readOrMark<T>(
  tables: readonly string[],
  unreadable: string[],
  run: () => Promise<T[]>,
): Promise<T[]> {
  try {
    return await run();
  } catch (error) {
    for (const table of tables) if (!unreadable.includes(table)) unreadable.push(table);
    logger.warn('Métrique indisponible — lecture impossible', { tables, error });
    return [];
  }
}

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fingerprint(conversationId: string): string {
  let hash = 0;
  for (let i = 0; i < conversationId.length; i += 1) {
    hash = (hash * 31 + conversationId.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36).padStart(7, '0').slice(0, 7);
}

function parseDetails(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readToolNames(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((name): name is string => typeof name === 'string')
    : [];
}

interface RunRow {
  status: string;
  error_message: string | null;
  details: string | null;
}

function summariseRuns(rows: readonly RunRow[]): {
  agentRuns: number;
  agentRunsFailed: number;
  requalifiedResponses: number;
  latenciesMs: readonly number[];
  toolCallCounts: Record<string, number>;
} {
  const latenciesMs: number[] = [];
  const toolCallCounts: Record<string, number> = {};
  let agentRunsFailed = 0;
  let requalifiedResponses = 0;

  for (const row of rows) {
    if (row.status === 'failure') agentRunsFailed += 1;

    const details = parseDetails(row.details);
    if (!details) continue;

    if (details.unsupportedClaim || details.deliveryPromise) requalifiedResponses += 1;

    const duration = Number(details.durationMs);
    if (Number.isFinite(duration) && duration >= 0) latenciesMs.push(duration);

    for (const name of readToolNames(details.toolCalls)) {
      toolCallCounts[name] = (toolCallCounts[name] ?? 0) + 1;
    }
  }

  return {
    agentRuns: rows.length,
    agentRunsFailed,
    requalifiedResponses,
    latenciesMs,
    toolCallCounts,
  };
}

export class DrizzleDashboardFactsRepository implements DashboardFactsRepository {
  constructor(private readonly resolveDb: () => DatabaseInstance = getDb) {}

  async readFacts(now: Date): Promise<DashboardFacts> {
    const db = this.resolveDb();
    const since = now.getTime() - WINDOW_HOURS * 60 * 60 * 1000;
    const liveSince = now.getTime() - LIVE_WINDOW_MS;
    const unreadable: string[] = [];

    const [
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
    ] = await Promise.all([
      readOrMark(['slack_directory'], unreadable, () =>
        db.all<{ total: number; linked: number }>(sql`
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN employee_id IS NOT NULL THEN 1 ELSE 0 END) AS linked
            FROM slack_directory
            WHERE is_deleted = 0 AND is_bot = 0
          `),
      ),
      readOrMark(['employees'], unreadable, () =>
        db.all<{ total: number }>(sql`
            SELECT COUNT(*) AS total FROM employees WHERE deleted_at IS NULL
          `),
      ),
      readOrMark(['onboarding_progress'], unreadable, () =>
        db.all<{ completed: number }>(sql`
            SELECT SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END) AS completed
            FROM onboarding_progress
          `),
      ),
      readOrMark(['onboarding_progress'], unreadable, () =>
        db.all<{ duration_ms: number }>(sql`
            SELECT (julianday(completed_at) - julianday(started_at)) * 86400000 AS duration_ms
            FROM onboarding_progress
            WHERE completed_at IS NOT NULL AND started_at IS NOT NULL
            LIMIT ${SAMPLE_CAP}
          `),
      ),
      readOrMark(['onboarding_interview'], unreadable, () =>
        db.all<{ total: number }>(sql`SELECT COUNT(*) AS total FROM onboarding_interview`),
      ),
      readOrMark(['conversation_turns'], unreadable, () =>
        db.all<{
          user_turns: number;
          assistant_turns: number;
          distinct_users: number;
          active_users: number;
          open_conversations: number;
        }>(sql`
            SELECT
              SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS user_turns,
              SUM(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END) AS assistant_turns,
              COUNT(DISTINCT CASE WHEN role = 'user' THEN slack_user_id END) AS distinct_users,
              COUNT(DISTINCT CASE WHEN created_at >= ${liveSince} THEN slack_user_id END) AS active_users,
              COUNT(DISTINCT CASE WHEN created_at >= ${liveSince} THEN conversation_id END) AS open_conversations
            FROM conversation_turns
            WHERE created_at >= ${since}
          `),
      ),
      readOrMark(['conversation_turns'], unreadable, () =>
        db.all<{ answered: number; delay_ms: number | null }>(sql`
            SELECT
              CASE WHEN next_role = 'user' THEN 1 ELSE 0 END AS answered,
              CASE WHEN next_role = 'user' THEN next_at - created_at END AS delay_ms
            FROM (
              SELECT
                role,
                created_at,
                LEAD(role)       OVER (PARTITION BY conversation_id ORDER BY created_at) AS next_role,
                LEAD(created_at) OVER (PARTITION BY conversation_id ORDER BY created_at) AS next_at
              FROM conversation_turns
              WHERE created_at >= ${since}
            )
            WHERE role = 'assistant'
            LIMIT ${SAMPLE_CAP}
          `),
      ),
      readOrMark(['audit_logs'], unreadable, () =>
        db.all<{ model_handled: number; failures: number; rate_limited: number }>(sql`
            SELECT
              SUM(CASE WHEN action = ${AUDIT_ACTIONS.slackMessage} THEN 1 ELSE 0 END) AS model_handled,
              SUM(CASE WHEN status IN ('failure', 'denied') THEN 1 ELSE 0 END) AS failures,
              SUM(CASE WHEN action = ${AUDIT_ACTIONS.rateLimited} THEN 1 ELSE 0 END) AS rate_limited
            FROM audit_logs
            WHERE julianday(created_at) >= julianday('now', ${WINDOW})
          `),
      ),
      readOrMark(['audit_logs'], unreadable, () =>
        db.all<{ status: string; error_message: string | null; details: string | null }>(sql`
            SELECT status, error_message, details
            FROM audit_logs
            WHERE action = ${AUDIT_ACTIONS.agentRun}
              AND julianday(created_at) >= julianday('now', ${WINDOW})
            LIMIT ${SAMPLE_CAP}
          `),
      ),
      readOrMark(['notifications'], unreadable, () =>
        db.all<{ total: number; failed: number }>(sql`
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
            FROM notifications
          `),
      ),
      readOrMark(['documents'], unreadable, () =>
        db.all<{ total: number; delivered: number }>(sql`
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS delivered
            FROM documents
            WHERE deleted_at IS NULL
          `),
      ),
      readOrMark(['conversation_turns'], unreadable, () =>
        db.all<{
          at: number;
          role: string;
          agent_id: string;
          conversation_id: string;
          len: number;
        }>(
          sql`
              SELECT created_at AS at, role, agent_id, conversation_id, LENGTH(content) AS len
              FROM conversation_turns
              ORDER BY created_at DESC
              LIMIT ${FEED_SIZE}
            `,
        ),
      ),
    ]);

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

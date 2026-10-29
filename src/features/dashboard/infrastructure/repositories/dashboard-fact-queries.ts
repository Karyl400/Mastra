import { sql } from 'drizzle-orm';

import type { DatabaseInstance } from '../../../../infrastructure/database/connection';
import { AUDIT_ACTIONS } from '../../../../shared/audit-actions';
import { FEED_SIZE, WINDOW_HOURS } from '../../domain/ports/dashboard-facts.repository';
import { readOrMark } from './dashboard-fact-readers';

const WINDOW = `-${WINDOW_HOURS} hours`;

const SAMPLE_CAP = 500;

export async function readDashboardRows(
  db: DatabaseInstance,
  since: number,
  liveSince: number,
  unreadable: string[],
) {
  const [onboarding, activity, operations] = await Promise.all([
    readOnboardingRows(db, unreadable),
    readActivityRows(db, since, liveSince, unreadable),
    readOperationRows(db, unreadable),
  ]);

  return { ...onboarding, ...activity, ...operations };
}

async function readOnboardingRows(db: DatabaseInstance, unreadable: string[]) {
  const [people, records, progress, durations, interviews] = await Promise.all([
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
  ]);

  return { people, records, progress, durations, interviews };
}

async function readActivityRows(
  db: DatabaseInstance,
  since: number,
  liveSince: number,
  unreadable: string[],
) {
  const [turns, pairs, feed] = await Promise.all([
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

  return { turns, pairs, feed };
}

async function readOperationRows(db: DatabaseInstance, unreadable: string[]) {
  const [audit, runs, notif, docs] = await Promise.all([
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
  ]);

  return { audit, runs, notif, docs };
}

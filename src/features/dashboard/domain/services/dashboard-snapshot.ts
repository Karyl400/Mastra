import { tableOf, type DashboardFacts } from '../ports/dashboard-facts.repository';
import { METRIC_CATALOGUE } from './metric-catalogue';
import type { MetricReading, MetricSpec, ResolvedMetric } from '../value-objects/metric';

const NO_DATA_YET: MetricReading = { available: false, gap: 'no_data_yet' };

function ratio(numerator: number, denominator: number, detail?: string): MetricReading {
  if (denominator <= 0) return NO_DATA_YET;

  const suffix =
    numerator > denominator
      ? ' — incohérent : les deux tables ne parlent pas de la même population'
      : '';

  return {
    available: true,
    value: Math.round((numerator / denominator) * 100),
    ...(detail ? { detail: detail + suffix } : {}),
  };
}

function count(value: number, detail?: string): MetricReading {
  return { available: true, value, ...(detail ? { detail } : {}) };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function minutes(ms: number | null, sampleCount: number): MetricReading {
  if (ms === null) return NO_DATA_YET;
  return { available: true, value: Math.round(ms / 60_000), detail: `${sampleCount} mesures` };
}

function readingFor(spec: MetricSpec, f: DashboardFacts): MetricReading {
  if (!spec.source.derived) return { available: false, gap: spec.source.gap };

  const unreadable = new Set(f.unreadableTables);
  if (spec.source.from.some((label) => unreadable.has(tableOf(label)))) {
    return { available: false, gap: 'read_failed' };
  }

  switch (spec.key) {
    case 'onboarding.people':
      return count(f.directoryPeople);
    case 'onboarding.linked':
      return count(f.directoryLinked, `sur ${f.directoryPeople}`);
    case 'onboarding.records':
      return count(f.employeeRecords);
    case 'onboarding.completed':
      return count(f.progressCompleted);
    case 'onboarding.interviews':
      return count(f.interviewsFilled);
    case 'onboarding.completionRate':
      return ratio(
        f.progressCompleted,
        f.directoryPeople,
        `${f.progressCompleted} / ${f.directoryPeople}`,
      );
    case 'onboarding.timeToComplete':
      return minutes(mean(f.completionDurationsMs), f.completionDurationsMs.length);
    case 'onboarding.funnel': {
      const stages = [
        f.directoryPeople,
        f.directoryLinked,
        f.employeeRecords,
        f.progressCompleted,
        f.interviewsFilled,
      ];
      const monotonic = stages.every((v, i) => i === 0 || v <= stages[i - 1]);
      return count(
        f.directoryPeople,
        stages.join(' → ') +
          (monotonic
            ? ''
            : ' — incohérent : un étage dépasse le précédent, les tables ne comptent pas la ' +
              'même population'),
      );
    }

    case 'engagement.messages':
      return count(f.userTurns);
    case 'engagement.perUser':
      return f.distinctUsers > 0
        ? {
            available: true,
            value: Math.round((f.userTurns / f.distinctUsers) * 10) / 10,
            detail: `${f.distinctUsers} personnes`,
          }
        : NO_DATA_YET;
    case 'engagement.replyRate':
      return ratio(
        f.assistantTurnsFollowedByUser,
        f.assistantTurnsAnswerable,
        `${f.assistantTurnsFollowedByUser} / ${f.assistantTurnsAnswerable}`,
      );
    case 'engagement.replyDelay':
      return minutes(median(f.humanReplyDelaysMs), f.humanReplyDelaysMs.length);
    case 'engagement.profileActivation':
      return ratio(
        f.employeeRecords,
        f.directoryPeople,
        `${f.employeeRecords} / ${f.directoryPeople}`,
      );

    case 'ai.zeroTokenShare': {
      if (f.userTurns <= 0) return NO_DATA_YET;
      const withoutModel = Math.max(0, f.userTurns - f.modelHandledMessages);
      return {
        available: true,
        value: Math.round((withoutModel / f.userTurns) * 100),
        detail: `estimation — ${withoutModel} / ${f.userTurns}`,
      };
    }
    case 'ai.modelHandled':
      return count(f.modelHandledMessages);
    case 'ai.unsupportedClaims':
      return count(f.requalifiedResponses, `sur ${f.agentRuns} runs`);
    case 'ai.runFailures':
      return count(f.agentRunsFailed, `sur ${f.agentRuns} runs`);
    case 'ai.toolCalls': {
      const entries = Object.entries(f.toolCallCounts).sort((a, b) => b[1] - a[1]);
      const total = entries.reduce((sum, [, n]) => sum + n, 0);
      return entries.length === 0
        ? NO_DATA_YET
        : count(total, entries.map(([name, n]) => `${name} ${n}`).join(' · '));
    }
    case 'ai.latency':
      return f.latenciesMs.length === 0
        ? NO_DATA_YET
        : {
            available: true,
            value: Math.round(median(f.latenciesMs) ?? 0),
            detail: `${f.latenciesMs.length} runs`,
          };

    case 'health.notificationFailure':
      return ratio(
        f.notificationsFailed,
        f.notificationsTotal,
        `${f.notificationsFailed} / ${f.notificationsTotal}`,
      );
    case 'health.documentDelivery':
      return ratio(
        f.documentsDelivered,
        f.documentsTotal,
        `${f.documentsDelivered} / ${f.documentsTotal}`,
      );
    case 'health.errors':
      return count(f.auditFailures);
    case 'health.rateLimited':
      return count(f.rateLimited);

    case 'live.activeUsers':
      return count(f.activeUsers);
    case 'live.openConversations':
      return count(f.openConversations);
    case 'live.feed':
      return count(f.feed.length);

    default:
      return NO_DATA_YET;
  }
}

export function buildSnapshot(facts: DashboardFacts): readonly ResolvedMetric[] {
  return METRIC_CATALOGUE.map((spec) => ({ ...spec, reading: readingFor(spec, facts) }));
}

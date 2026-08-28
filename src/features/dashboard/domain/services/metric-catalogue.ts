import { METRIC_FAMILIES, type MetricSpec } from '../value-objects/metric';
import { ONBOARDING_METRICS } from './metric-catalogue-onboarding';
import { ENGAGEMENT_METRICS } from './metric-catalogue-engagement';
import { AI_METRICS } from './metric-catalogue-ai';
import { HEALTH_METRICS } from './metric-catalogue-health';
import { SATISFACTION_METRICS } from './metric-catalogue-satisfaction';
import { LIVE_METRICS } from './metric-catalogue-live';

export { METRIC_FAMILIES };
export type { MetricSpec };

const CATALOGUE: readonly MetricSpec[] = [
  ...ONBOARDING_METRICS,
  ...ENGAGEMENT_METRICS,
  ...AI_METRICS,
  ...HEALTH_METRICS,
  ...SATISFACTION_METRICS,
  ...LIVE_METRICS,
];

export const METRIC_CATALOGUE = CATALOGUE;

export function derivableMetrics(): readonly MetricSpec[] {
  return CATALOGUE.filter((m) => m.source.derived);
}

export function missingMetrics(): readonly MetricSpec[] {
  return CATALOGUE.filter((m) => !m.source.derived);
}

export function metricsOf(family: string): readonly MetricSpec[] {
  return CATALOGUE.filter((m) => m.family === family);
}

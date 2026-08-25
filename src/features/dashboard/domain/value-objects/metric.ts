export const METRIC_FAMILIES = [
  'onboarding',
  'engagement',
  'ai',
  'health',
  'satisfaction',
  'live',
] as const;

export type MetricFamily = (typeof METRIC_FAMILIES)[number];

export type MetricGap =
  | 'no_mechanism'
  | 'not_persisted'
  | 'no_events'
  | 'external_owner'
  | 'read_failed'
  | 'no_data_yet'
  | 'not_comparable';

export type MetricUnit = 'count' | 'percent' | 'minutes' | 'ms';

export type MetricSource =
  | { readonly derived: true; readonly from: readonly string[]; readonly caveat?: string }
  | {
      readonly derived: false;
      readonly gap: MetricGap;
      readonly because: string;
      readonly wouldTake: string;
    };

export interface MetricSpec {
  readonly key: string;
  readonly family: MetricFamily;
  readonly label: string;
  readonly unit: MetricUnit;
  readonly source: MetricSource;
}

export type MetricReading =
  | { readonly available: true; readonly value: number; readonly detail?: string }
  | { readonly available: false; readonly gap: MetricGap };

export interface ResolvedMetric extends MetricSpec {
  readonly reading: MetricReading;
}

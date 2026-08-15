import type {
  OperationalMetricCategory,
  OperationalMetricEvent,
  OperationalMetricSummary,
  OperationalMetricSummaryBucket,
} from "./operational-metrics.ts";

const MAX_DURATION_SAMPLES = 4_096;
const MAX_SUMMARY_KEYS = 512;

interface BoundedDurationSamples {
  values: number[];
  seen: number;
  sum: number;
  min: number | null;
  max: number | null;
}

export interface OperationalMetricSummaryAccumulator {
  totalEvents: number;
  latestEventTs: number | null;
  byCategory: Partial<Record<OperationalMetricCategory, OperationalMetricSummaryBucket>>;
  byName: Record<string, OperationalMetricSummaryBucket>;
  durationsByCategory: Partial<Record<OperationalMetricCategory, BoundedDurationSamples>>;
  durationsByName: Record<string, BoundedDurationSamples>;
}

function emptyBucket(): OperationalMetricSummaryBucket {
  return {
    events: 0,
    errors: 0,
    skipped: 0,
    durationMs: { count: 0, min: null, max: null, average: null, p50: null, p95: null },
  };
}

function emptyDurations(): BoundedDurationSamples {
  return { values: [], seen: 0, sum: 0, min: null, max: null };
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

function addDurationSample(samples: BoundedDurationSamples, value: number): void {
  samples.seen += 1;
  samples.sum += value;
  samples.min = samples.min === null ? value : Math.min(samples.min, value);
  samples.max = samples.max === null ? value : Math.max(samples.max, value);
  if (samples.values.length < MAX_DURATION_SAMPLES) {
    samples.values.push(value);
    return;
  }
  samples.values[samples.seen % MAX_DURATION_SAMPLES] = value;
}

function finalizeBucket(bucket: OperationalMetricSummaryBucket, durations: BoundedDurationSamples): void {
  if (!durations.seen) return;
  bucket.durationMs = {
    count: durations.seen,
    min: durations.min,
    max: durations.max,
    average: Number((durations.sum / durations.seen).toFixed(2)),
    p50: percentile(durations.values, 50),
    p95: percentile(durations.values, 95),
  };
}

function boundedNameKey(record: Record<string, OperationalMetricSummaryBucket>, key: string): string {
  if (Object.prototype.hasOwnProperty.call(record, key)) return key;
  if (Object.keys(record).length >= MAX_SUMMARY_KEYS) return "__other__";
  return key;
}

export function createOperationalMetricSummaryAccumulator(): OperationalMetricSummaryAccumulator {
  return {
    totalEvents: 0,
    latestEventTs: null,
    byCategory: {},
    byName: {},
    durationsByCategory: {},
    durationsByName: {},
  };
}

export function addOperationalMetricSummaryEvent(
  accumulator: OperationalMetricSummaryAccumulator,
  event: OperationalMetricEvent,
): void {
  accumulator.totalEvents += 1;
  const categoryKey = Object.prototype.hasOwnProperty.call(accumulator.byCategory, event.category) ||
    Object.keys(accumulator.byCategory).length < 32
    ? event.category
    : "maintenance";
  const categoryBucket = accumulator.byCategory[categoryKey] ??= emptyBucket();
  const nameKey = boundedNameKey(accumulator.byName, `${categoryKey}:${event.name}`);
  const nameBucket = accumulator.byName[nameKey] ??= emptyBucket();
  categoryBucket.events += 1;
  nameBucket.events += 1;
  if (event.status === "error") {
    categoryBucket.errors += 1;
    nameBucket.errors += 1;
  }
  if (event.status === "skipped") {
    categoryBucket.skipped += 1;
    nameBucket.skipped += 1;
  }
  if (typeof event.durationMs === "number") {
    const categorySamples = accumulator.durationsByCategory[categoryKey] ??=
      emptyDurations();
    addDurationSample(categorySamples, event.durationMs);
    const nameSamples = accumulator.durationsByName[nameKey] ??= emptyDurations();
    addDurationSample(nameSamples, event.durationMs);
  }
  accumulator.latestEventTs = accumulator.latestEventTs === null
    ? event.ts
    : Math.max(accumulator.latestEventTs, event.ts);
}

export function finalizeOperationalMetricSummary(
  accumulator: OperationalMetricSummaryAccumulator,
  input: {
    enabled: boolean;
    parseErrors: number;
    sinceTs: number | null;
  },
): OperationalMetricSummary {
  for (const [category, bucket] of Object.entries(accumulator.byCategory)) {
    finalizeBucket(bucket, accumulator.durationsByCategory[category as OperationalMetricCategory] ?? emptyDurations());
  }
  for (const [name, bucket] of Object.entries(accumulator.byName)) {
    finalizeBucket(bucket, accumulator.durationsByName[name] ?? emptyDurations());
  }
  return {
    enabled: input.enabled,
    totalEvents: accumulator.totalEvents,
    parseErrors: input.parseErrors,
    sinceTs: input.sinceTs,
    byCategory: accumulator.byCategory,
    byName: accumulator.byName,
    latestEventTs: accumulator.latestEventTs,
    privacy: {
      rawTextStored: false,
      rawPromptsIncluded: false,
      rawMessagesIncluded: false,
      rawToolPayloadsIncluded: false,
      rawCredentialsIncluded: false,
    },
  };
}

/**
 * Adaptive time bucketing for UsageBars: 15-minute usage slots become at most
 * `maxBars` buckets of one shared step, aligned to local wall-clock time.
 * Pure: no clock reads, no DOM. Empty buckets stay in the list as gaps, so
 * the time scale stays honest.
 */

/** Bucket steps in hours, smallest first: 1, 2, 3, 6, 12 hours, then 1, 2 and 7 days. */
export const USAGE_BUCKET_STEPS = [1, 2, 3, 6, 12, 24, 48, 168] as const;
export type UsageBucketStepHours = (typeof USAGE_BUCKET_STEPS)[number];

/** Length of one input slot. */
export const USAGE_SLOT_MS = 15 * 60 * 1000;
const DEFAULT_MAX_BARS = 24;

/** One 15-minute slot: its start (epoch ms) followed by its values (requests, tokens, ...). */
export type UsageSlot = readonly [startMs: number, ...values: number[]];

export interface UsageTimeBucket {
  /** Local-time aligned start, inclusive (epoch ms). */
  startMs: number;
  /** Start of the next bucket, exclusive (epoch ms). */
  endMs: number;
  /** Per-index sums of the slot values that start inside the bucket; zeros for a gap. */
  values: number[];
}

export interface UsageBucketing {
  stepHours: UsageBucketStepHours;
  buckets: UsageTimeBucket[];
}

export interface BucketUsageSlotsOptions {
  /** Window start (epoch ms); defaults to the earliest slot. */
  fromMs?: number;
  /** Window end, exclusive (epoch ms), usually "now"; defaults to the end of the latest slot. */
  toMs?: number;
  /** Most bars the chart may show; the smallest step that fits wins. Default 24. */
  maxBars?: number;
}

/** Start of the local-time bucket of `stepHours` that contains `ms`. */
export function alignUsageBucketStart(ms: number, stepHours: number): number {
  const date = new Date(ms);
  date.setMinutes(0, 0, 0);
  if (stepHours >= 24) date.setHours(0);
  else date.setHours(Math.floor(date.getHours() / stepHours) * stepHours);
  return date.getTime();
}

/** Next bucket start: wall-clock hours below a day, calendar days above (DST-safe). */
function nextBucketStart(ms: number, stepHours: number): number {
  const date = new Date(ms);
  if (stepHours >= 24) date.setDate(date.getDate() + stepHours / 24);
  else date.setHours(date.getHours() + stepHours);
  return date.getTime();
}

/** Bucket starts covering [fromMs, toMs); stops early once more than `limit` are needed. */
function bucketStarts(fromMs: number, toMs: number, stepHours: number, limit: number): number[] {
  const starts: number[] = [];
  for (let start = alignUsageBucketStart(fromMs, stepHours); start < toMs; start = nextBucketStart(start, stepHours)) {
    starts.push(start);
    if (starts.length > limit) break;
  }
  return starts;
}

/** Index of the last start <= ms, or -1. */
function bucketIndex(starts: readonly number[], ms: number): number {
  let low = 0;
  let high = starts.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (starts[mid]! <= ms) {
      found = mid;
      low = mid + 1;
    } else high = mid - 1;
  }
  return found;
}

function windowOf(slots: readonly UsageSlot[], options: BucketUsageSlotsOptions): [number, number] | null {
  if (options.fromMs !== undefined && options.toMs !== undefined) return [options.fromMs, options.toMs];
  if (slots.length === 0) return null;
  let first = Infinity;
  let last = -Infinity;
  for (const slot of slots) {
    first = Math.min(first, slot[0]);
    last = Math.max(last, slot[0]);
  }
  return [options.fromMs ?? first, options.toMs ?? last + USAGE_SLOT_MS];
}

/**
 * Groups 15-minute slots into the smallest step whose bucket count is at most
 * `maxBars` (7 days when none fits). Slots outside [fromMs, toMs) are left out.
 */
export function bucketUsageSlots(slots: readonly UsageSlot[], options: BucketUsageSlotsOptions = {}): UsageBucketing {
  const window = windowOf(slots, options);
  if (!window || window[1] <= window[0]) return { stepHours: USAGE_BUCKET_STEPS[0], buckets: [] };
  const [fromMs, toMs] = window;
  const maxBars = Math.max(1, Math.floor(options.maxBars ?? DEFAULT_MAX_BARS));
  let stepHours: UsageBucketStepHours = USAGE_BUCKET_STEPS[0];
  let starts: number[] = [];
  for (const step of USAGE_BUCKET_STEPS) {
    stepHours = step;
    starts = bucketStarts(fromMs, toMs, step, step === 168 ? Infinity : maxBars);
    if (starts.length <= maxBars) break;
  }
  const width = slots.reduce((most, slot) => Math.max(most, slot.length - 1), 0);
  const buckets = starts.map((startMs, index) => ({
    startMs,
    endMs: starts[index + 1] ?? nextBucketStart(startMs, stepHours),
    values: new Array<number>(width).fill(0),
  }));
  for (const slot of slots) {
    if (slot[0] < fromMs || slot[0] >= toMs) continue;
    const bucket = buckets[bucketIndex(starts, slot[0])];
    if (!bucket) continue;
    for (let value = 1; value < slot.length; value += 1) {
      bucket.values[value - 1] = (bucket.values[value - 1] ?? 0) + (slot[value] ?? 0);
    }
  }
  return { stepHours, buckets };
}

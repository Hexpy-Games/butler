/**
 * Adaptive time bucketing for UsageBars: 15-minute usage slots become at most
 * `maxBars` buckets of one shared step, aligned to local wall-clock time.
 * Pure: no clock reads, no DOM. Empty buckets stay in the list as gaps, so
 * the time scale stays honest. Bucket starts are wall-clock times: a DST
 * change lengthens or shortens only the bucket it falls in.
 */

import { bucketGrid, DEFAULT_WEEK_START, modulo, type BucketGrid } from "./usageBucketGrid";

export { alignUsageBucketStart } from "./usageBucketGrid";

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
  /** First day of a 7-day bucket (0 Sunday ... 6 Saturday). Default 1 (Monday). */
  weekStartsOn?: number;
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
  const weekStartsOn = modulo(Math.floor(options.weekStartsOn ?? DEFAULT_WEEK_START), 7);
  let stepHours: UsageBucketStepHours = USAGE_BUCKET_STEPS[0];
  let grid: BucketGrid = { starts: [], end: toMs };
  for (const step of USAGE_BUCKET_STEPS) {
    stepHours = step;
    grid = bucketGrid(fromMs, toMs, step, weekStartsOn, step === 168 ? Infinity : maxBars);
    if (grid.starts.length <= maxBars) break;
  }
  const { starts, end } = grid;
  const width = slots.reduce((most, slot) => Math.max(most, slot.length - 1), 0);
  const buckets = starts.map((startMs, index) => ({
    startMs,
    endMs: starts[index + 1] ?? end,
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

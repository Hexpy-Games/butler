// test-category: pure-logic
import { afterEach, describe, expect, test } from "bun:test";
import { alignUsageBucketStart, bucketUsageSlots, USAGE_SLOT_MS, type UsageSlot } from "./usageBuckets";

const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
const HOUR = 3_600_000;

describe("bucketUsageSlots", () => {
  test("hourly buckets from the first slot's hour to now, gaps kept, values summed per index", () => {
    const slots: UsageSlot[] = [[at(15, 9, 15), 1, 10], [at(15, 9, 45), 2, 20], [at(15, 12, 0), 5, 50], [at(15, 15, 30), 7, 70]];
    const result = bucketUsageSlots(slots, { toMs: at(15, 15, 32) });
    expect(result.stepHours).toBe(1);
    expect(result.buckets.map((bucket) => bucket.startMs)).toEqual([9, 10, 11, 12, 13, 14, 15].map((hour) => at(15, hour)));
    expect(result.buckets.map((bucket) => bucket.values)).toEqual([[3, 30], [0, 0], [0, 0], [5, 50], [0, 0], [0, 0], [7, 70]]);
    expect(result.buckets.at(-1)!.endMs).toBe(at(15, 16));
  });

  test("picks the smallest step whose bucket count fits maxBars, aligned to local time", () => {
    const toMs = at(15, 15, 32);
    const week = bucketUsageSlots([], { fromMs: toMs - 168 * HOUR, toMs, maxBars: 31 });
    expect(week.stepHours).toBe(6);
    expect(week.buckets.length).toBeLessThanOrEqual(31);
    expect(week.buckets.every((bucket) => new Date(bucket.startMs).getHours() % 6 === 0 && new Date(bucket.startMs).getMinutes() === 0)).toBe(true);
    const month = bucketUsageSlots([], { fromMs: toMs - 720 * HOUR, toMs, maxBars: 31 });
    expect(month.stepHours).toBe(24);
    expect(month.buckets.every((bucket) => new Date(bucket.startMs).getHours() === 0)).toBe(true);
    expect(bucketUsageSlots([], { fromMs: toMs - 720 * HOUR, toMs }).stepHours).toBe(48);
    expect(bucketUsageSlots([], { fromMs: toMs - 24 * HOUR, toMs }).stepHours).toBe(2);
  });

  test("falls back to 7-day buckets when nothing fits", () => {
    const toMs = at(15, 15);
    const result = bucketUsageSlots([], { fromMs: toMs - 400 * 24 * HOUR, toMs, maxBars: 24 });
    expect(result.stepHours).toBe(168);
    expect(result.buckets.length).toBeGreaterThan(24);
    expect(result.buckets.at(-1)!.endMs).toBeGreaterThan(toMs);
  });

  test("ignores slots outside the window, pads short slots, accepts unsorted input", () => {
    const slots: UsageSlot[] = [[at(15, 11), 4], [at(14, 23), 99, 99], [at(15, 10, 15), 1, 2], [at(15, 13), 99]];
    const result = bucketUsageSlots(slots, { fromMs: at(15, 10), toMs: at(15, 12) });
    expect(result.buckets.map((bucket) => bucket.values)).toEqual([[1, 2], [4, 0]]);
  });

  test("an empty input or an empty window gives no buckets", () => {
    expect(bucketUsageSlots([])).toEqual({ stepHours: 1, buckets: [] });
    expect(bucketUsageSlots([[at(15, 9), 1]], { fromMs: at(15, 10), toMs: at(15, 10) }).buckets).toEqual([]);
  });

  test("a lone slot makes one bucket ending at the slot's end by default", () => {
    const result = bucketUsageSlots([[at(15, 15, 30), 3]]);
    expect(result.buckets).toEqual([{ startMs: at(15, 15), endMs: at(15, 16), values: [3] }]);
    expect(at(15, 15, 30) + USAGE_SLOT_MS).toBeLessThanOrEqual(result.buckets[0]!.endMs);
  });
});

describe("alignUsageBucketStart", () => {
  test("aligns sub-day steps to wall-clock multiples and day steps to midnight", () => {
    expect(alignUsageBucketStart(at(15, 14, 40), 3)).toBe(at(15, 12));
    expect(alignUsageBucketStart(at(15, 14, 40), 12)).toBe(at(15, 12));
    expect(alignUsageBucketStart(at(15, 14, 40), 24)).toBe(at(15, 0));
    // Oct 15, 2026 is local day 20,741 (odd), so its 2-day bucket began on the 14th; Oct 15 is a Thursday.
    expect(alignUsageBucketStart(at(15, 14, 40), 48)).toBe(at(14, 0));
    expect(alignUsageBucketStart(at(15, 14, 40), 168)).toBe(at(12, 0));
    expect(alignUsageBucketStart(at(15, 14, 40), 168, 0)).toBe(at(11, 0));
  });
});

describe("fixed multi-day anchors", () => {
  const dayNumber = (ms: number) => {
    const date = new Date(ms);
    return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);
  };

  test("2-day buckets sit on an even local-day grid and 7-day buckets start on weekStartsOn", () => {
    const toMs = at(15, 15);
    const twoDays = bucketUsageSlots([], { fromMs: toMs - 30 * 24 * HOUR, toMs, maxBars: 24 });
    expect(twoDays.stepHours).toBe(48);
    expect(twoDays.buckets.every((bucket) => dayNumber(bucket.startMs) % 2 === 0)).toBe(true);
    const weeks = bucketUsageSlots([], { fromMs: toMs - 120 * 24 * HOUR, toMs, maxBars: 24 });
    expect(weeks.stepHours).toBe(168);
    expect(weeks.buckets.every((bucket) => new Date(bucket.startMs).getDay() === 1)).toBe(true);
    const sundays = bucketUsageSlots([], { fromMs: toMs - 120 * 24 * HOUR, toMs, maxBars: 24, weekStartsOn: 0 });
    expect(sundays.buckets.every((bucket) => new Date(bucket.startMs).getDay() === 0)).toBe(true);
  });

  test("a rolling window keeps its 2-day boundaries when it moves by a day", () => {
    const today = bucketUsageSlots([], { fromMs: at(15, 15) - 30 * 24 * HOUR, toMs: at(15, 15), maxBars: 24 });
    const tomorrow = bucketUsageSlots([], { fromMs: at(16, 15) - 30 * 24 * HOUR, toMs: at(16, 15), maxBars: 24 });
    const later = new Set(tomorrow.buckets.map((bucket) => bucket.startMs));
    expect(today.buckets.slice(1).every((bucket) => later.has(bucket.startMs))).toBe(true);
  });
});

describe("daylight saving changes", () => {
  const original = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  afterEach(() => { process.env.TZ = original; });
  const hours = (buckets: { startMs: number }[]) => buckets.map((bucket) => new Date(bucket.startMs).getHours());

  test("spring forward (New York, 2026-03-08) moves only the bucket in the skipped hour", () => {
    process.env.TZ = "America/New_York";
    const result = bucketUsageSlots([], { fromMs: new Date(2026, 2, 7, 12).getTime(), toMs: new Date(2026, 2, 9, 12).getTime() });
    expect(result.stepHours).toBe(2);
    expect(hours(result.buckets).filter((hour) => hour % 2 !== 0)).toEqual([3]);
    expect(result.buckets.some((bucket) => bucket.startMs === new Date(2026, 2, 8, 4).getTime())).toBe(true);
    expect(result.buckets.at(-1)!.startMs).toBe(new Date(2026, 2, 9, 10).getTime());
  });

  test("hourly buckets across the skipped hour make one bucket, not two", () => {
    process.env.TZ = "America/New_York";
    const result = bucketUsageSlots([], { fromMs: new Date(2026, 2, 8, 0).getTime(), toMs: new Date(2026, 2, 8, 5).getTime() });
    expect(hours(result.buckets)).toEqual([0, 1, 3, 4]);
  });

  test("fall back (New York, 2026-11-01): the repeated hour lengthens one bucket and its usage lands there", () => {
    process.env.TZ = "America/New_York";
    const repeated = new Date(2026, 10, 1, 1, 30).getTime() + HOUR;
    const result = bucketUsageSlots([[repeated, 5]], { fromMs: new Date(2026, 10, 1, 0).getTime(), toMs: new Date(2026, 10, 1, 4).getTime() });
    expect(hours(result.buckets)).toEqual([0, 1, 2, 3]);
    expect(result.buckets[1]!.endMs - result.buckets[1]!.startMs).toBe(2 * HOUR);
    expect(result.buckets.map((bucket) => bucket.values[0])).toEqual([0, 5, 0, 0]);
  });

  test("day buckets keep local midnight after a skipped midnight (Santiago, 2026-09-06)", () => {
    process.env.TZ = "America/Santiago";
    const result = bucketUsageSlots([], { fromMs: new Date(2026, 8, 1).getTime(), toMs: new Date(2026, 8, 12).getTime(), maxBars: 12 });
    expect(result.stepHours).toBe(24);
    expect(hours(result.buckets)).toEqual([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0]);
  });
});

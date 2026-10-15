// test-category: pure-logic
import { describe, expect, test } from "bun:test";
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
    expect(alignUsageBucketStart(at(15, 14, 40), 48)).toBe(at(15, 0));
  });
});

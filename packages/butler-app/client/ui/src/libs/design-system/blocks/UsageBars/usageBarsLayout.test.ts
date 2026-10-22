// test-category: pure-logic
import { describe, expect, test } from "bun:test";
import { mergeTinyPart, usageBarsGeometry } from "./usageBarsLayout";
import type { UsageBarsBucket, UsageBarsSeries } from "./usageBarsTypes";

const SERIES: UsageBarsSeries[] = [
  { id: "new", color: "chart-1", label: "New input" },
  { id: "cached", color: "chart-5", label: "Cached" },
  { id: "output", color: "chart-2", label: "Output" },
];
const bucket = (key: string, segments: UsageBarsBucket["segments"]): UsageBarsBucket => ({ key, segments, label: key, valueText: "" });

describe("usageBarsGeometry split", () => {
  test("each segment's subtask share is its subtask value over its value, clamped to the segment", () => {
    const { columns } = usageBarsGeometry([bucket("a", [
      { id: "new", value: 20_000, subtask: 5_000 },
      { id: "cached", value: 60_000, subtask: 45_000 },
      { id: "output", value: 20_000, subtask: 90_000 },
    ])], SERIES, { minSlots: 8, ticks: false, size: "panel" });
    expect(columns[0]!.segments.map((segment) => [segment.share, segment.subtask])).toEqual([[0.2, 0.25], [0.6, 0.75], [0.2, 1]]);
  });

  test("segments without a subtask value stay solid", () => {
    const { columns } = usageBarsGeometry([bucket("a", [{ id: "new", value: 10 }, { id: "cached", value: 30, subtask: 0 }])], SERIES,
      { minSlots: 8, ticks: false, size: "popover" });
    expect(columns[0]!.segments.map((segment) => segment.subtask)).toEqual([0, 0]);
  });

  test("a part under 2px merges into its larger part, from the plot height of the size", () => {
    // The tallest column fills the 56px popover; a 5% subtask part of a 40% segment is 1.1px.
    const buckets = [bucket("a", [{ id: "new", value: 60 }, { id: "cached", value: 40, subtask: 2 }])];
    expect(usageBarsGeometry(buckets, SERIES, { minSlots: 8, ticks: false, size: "popover" }).columns[0]!.segments[1]!.subtask).toBe(0);
    // The same share is 4.0px in the 200px panel plot (208px less the ticks' headroom), so it stays split.
    expect(usageBarsGeometry(buckets, SERIES, { minSlots: 8, ticks: true, size: "panel" }).columns[0]!.segments[1]!.subtask).toBe(0.05);
  });

  test("mergeTinyPart keeps parts of 2px or more and picks the larger style otherwise (solid on a tie)", () => {
    expect(mergeTinyPart(0.5, 4)).toBe(0.5);
    expect(mergeTinyPart(0.9, 10)).toBe(1);
    expect(mergeTinyPart(0.1, 10)).toBe(0);
    expect(mergeTinyPart(0.5, 3)).toBe(0);
    expect(mergeTinyPart(1, 1)).toBe(1);
    expect(mergeTinyPart(0, 1)).toBe(0);
  });
});

import type { UsageBarsAxisLabel, UsageBarsBucket, UsageBarsColor, UsageBarsSeries, UsageBarsSize } from "./usageBarsTypes";

export interface UsageBarsColumnSegment {
  id: string;
  color: UsageBarsColor;
  value: number;
}

export interface UsageBarsColumn {
  key: string;
  total: number;
  /** Height as a share of the plot's drawing height (0..1). */
  fraction: number;
  /** Drawn segments in stacking order, bottom first. */
  segments: UsageBarsColumnSegment[];
}

export interface UsageBarsGeometry {
  columns: UsageBarsColumn[];
  slots: number;
  /** Value of the plot top: the largest total, or a round ceiling with y ticks. */
  top: number;
  /** Gridline values (half and top) with y ticks; empty otherwise. */
  ticks: number[];
  /** No bucket has a positive total. */
  blank: boolean;
}

/** A round ceiling (1, 2, 4, 5, 8 or 10 × 10^n) so half and top ticks read cleanly. */
export function niceCeiling(value: number): number {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const fraction = value / magnitude;
  const step = [1, 2, 4, 5, 8].find((candidate) => fraction <= candidate) ?? 10;
  return step * magnitude;
}

function columnSegments(bucket: UsageBarsBucket, series: readonly UsageBarsSeries[]): UsageBarsColumnSegment[] {
  return series.flatMap((entry) => {
    const value = bucket.segments
      .filter((segment) => segment.id === entry.id)
      .reduce((sum, segment) => sum + (Number.isFinite(segment.value) && segment.value > 0 ? segment.value : 0), 0);
    return value > 0 ? [{ id: entry.id, color: entry.color, value }] : [];
  });
}

/** Columns, slot count and scale for the ready state. */
export function usageBarsGeometry(
  buckets: readonly UsageBarsBucket[],
  series: readonly UsageBarsSeries[],
  { minSlots, ticks }: { minSlots: number; ticks: boolean },
): UsageBarsGeometry {
  const stacked = buckets.map((bucket) => {
    const segments = columnSegments(bucket, series);
    return { key: bucket.key, segments, total: segments.reduce((sum, segment) => sum + segment.value, 0) };
  });
  const max = stacked.reduce((most, column) => Math.max(most, column.total), 0);
  const top = ticks ? niceCeiling(max) : Math.max(max, 1);
  return {
    columns: stacked.map((column) => ({ ...column, fraction: column.total / top })),
    slots: Math.max(buckets.length, Math.floor(minSlots), 1),
    top,
    ticks: ticks && max > 0 ? [top / 2, top] : [],
    blank: max <= 0,
  };
}

export interface UsageBarsAxisPlacement {
  key: string;
  text: string;
  /** Anchor as a share of the plot width (0..1). */
  left: number;
  align: "start" | "center" | "end";
}

/** Labels near an edge anchor to that edge so they never spill past the plot. */
export function placeAxisLabels(labels: readonly UsageBarsAxisLabel[], slots: number, size: UsageBarsSize): UsageBarsAxisPlacement[] {
  const edge = size === "panel" ? 0.06 : 0.12;
  return labels
    .filter((label) => label.index >= 0 && label.index < slots)
    .map((label) => {
      const start = label.index / slots;
      const end = (label.index + 1) / slots;
      if (start < edge) return { key: `${label.index}`, text: label.text, left: start, align: "start" };
      if (end > 1 - edge) return { key: `${label.index}`, text: label.text, left: end, align: "end" };
      return { key: `${label.index}`, text: label.text, left: (start + end) / 2, align: "center" };
    });
}

const SKELETON_SHAPE = [0.3, 0.52, 0.7, 0.18, 0.44, 0.86, 0.6, 0.24, 0.4, 0.18];

/** Placeholder column heights (share of the plot) for the loading state. */
export function skeletonHeights(slots: number): number[] {
  return Array.from({ length: slots }, (_, index) => SKELETON_SHAPE[index % SKELETON_SHAPE.length]!);
}

/** Bucket index under a pointer x, or null over an empty slot or outside the plot. */
export function bucketAtPointer(clientX: number, rect: { left: number; width: number }, slots: number, count: number): number | null {
  if (rect.width <= 0 || count <= 0) return null;
  const index = Math.floor(((clientX - rect.left) / rect.width) * slots);
  return index >= 0 && index < count ? index : null;
}

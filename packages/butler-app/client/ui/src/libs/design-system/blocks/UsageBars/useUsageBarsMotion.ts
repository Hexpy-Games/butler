import { useLayoutEffect, useRef, type RefObject } from "react";
import { animateMotion, motionDuration } from "../../lib/motion";

/** Marks the animated column elements inside the plot. */
export const USAGE_BARS_COLUMN_ATTRIBUTE = "data-usage-bars-column";
/** Marks a hatched (subtask) part; the value is "<bucket key>/<series id>". */
export const USAGE_BARS_HATCH_ATTRIBUTE = "data-usage-bars-hatch";

interface Drawn {
  count: number;
  /** Layout heights (px) of the columns as last drawn, before any transform. */
  heights: number[];
  /** Hatched parts as last drawn. */
  hatches: Set<string>;
}

/** This hook's column animations; the CSS selection-dim transition is left alone. */
function columnMotion(column: HTMLElement): Animation[] {
  return column.getAnimations().filter((animation) => !("transitionProperty" in animation));
}

/** The vertical scale a running animation currently paints (1 when idle). */
function paintedScale(column: HTMLElement): number {
  if (columnMotion(column).length === 0) return 1;
  const transform = window.getComputedStyle(column).transform;
  const matrix = /^matrix\(([^)]+)\)$/u.exec(transform);
  const scaleY = matrix ? Number(matrix[1]!.split(",")[3]) : 1;
  return Number.isFinite(scaleY) ? scaleY : 1;
}

/** Per-bar grow delay of the approved mockups; the whole stagger stays within --motion-slow. */
const GROW_STAGGER_MS = 12;

/** First show or a new bucket count: columns grow from the baseline, staggered (total stagger capped). */
function grow(columns: HTMLElement[]): void {
  const step = Math.min(GROW_STAGGER_MS, motionDuration("slow") / Math.max(columns.length, 1));
  columns.forEach((column, index) => {
    if (column.offsetHeight === 0) return;
    animateMotion(column, [{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }],
      { duration: "deliberate", easing: "decelerate", delay: Math.round(index * step), fill: "backwards" });
  });
}

/** Same bucket count, new values: each column eases from the height it painted to its new one (FLIP). */
function flip(columns: HTMLElement[], painted: number[], heights: number[]): void {
  columns.forEach((column, index) => {
    const to = heights[index]!;
    const from = painted[index]!;
    if (to === 0 || Math.abs(from - to) < 0.5) return;
    animateMotion(column, [{ transform: `scaleY(${from / to})` }, { transform: "scaleY(1)" }],
      { duration: "slow", easing: "standard" });
  });
}

/**
 * A hatched part that was not drawn before fades in over --motion-base and
 * grows up from its boundary with the part below over --motion-slow. Reduced
 * motion keeps only the fade.
 */
function appear(parts: HTMLElement[]): void {
  for (const part of parts) {
    animateMotion(part, [{ opacity: 0 }, { opacity: 1 }], { duration: "base", easing: "standard" });
    animateMotion(part, [{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }], { duration: "slow", easing: "decelerate" });
  }
}

/**
 * Column motion on transforms only; new hatched parts also fade in. Changes
 * are keyed by `signature` (the drawn heights and hatched parts), so a
 * selection change never replays motion. An update in flight starts from what
 * is painted now, so motion is interruptible. Reduced motion (OS or app)
 * draws the final heights at once: animateMotion drops transform-only
 * keyframes, and a new hatched part only fades in.
 */
export function useUsageBarsMotion(plotRef: RefObject<HTMLElement | null>, ready: boolean, signature: string): void {
  const drawn = useRef<Drawn | null>(null);
  useLayoutEffect(() => {
    const plot = plotRef.current;
    if (!ready || !plot) {
      drawn.current = null;
      return;
    }
    const columns = [...plot.querySelectorAll<HTMLElement>(`[${USAGE_BARS_COLUMN_ATTRIBUTE}]`)];
    const last = drawn.current;
    const sameShape = last !== null && last.count === columns.length;
    const painted = sameShape ? columns.map((column, index) => (last.heights[index] ?? 0) * paintedScale(column)) : [];
    for (const column of columns) for (const animation of columnMotion(column)) animation.cancel();
    const heights = columns.map((column) => column.offsetHeight);
    const parts = [...plot.querySelectorAll<HTMLElement>(`[${USAGE_BARS_HATCH_ATTRIBUTE}]`)];
    const hatches = new Set(parts.map((part) => part.getAttribute(USAGE_BARS_HATCH_ATTRIBUTE)!));
    drawn.current = { count: columns.length, heights, hatches };
    if (sameShape) flip(columns, painted, heights);
    else grow(columns);
    appear(parts.filter((part) => !last?.hatches.has(part.getAttribute(USAGE_BARS_HATCH_ATTRIBUTE)!)));
  }, [plotRef, ready, signature]);
}

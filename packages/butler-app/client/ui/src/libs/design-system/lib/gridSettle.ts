import { flushSync } from "react-dom";
import { animateMotion, motionDuration, prefersReducedMotion } from "./motion";

/**
 * The settle rule for a grid that grew while it was open (answer cards streaming in). While the list is open,
 * cells only arrive at the end and nothing earlier moves; when it closes, the final layout (the final column
 * count, equal row heights) is applied once. That is the only moment earlier cells may move, so it is eased:
 *
 * - a column change (5 cards: 4 + 1 becomes 3 + 2) hides the reflow behind a short opacity dip,
 *   out over --motion-exit-fast, back over --motion-base;
 * - the grid's height eases to the new size over --motion-slow.
 *
 * Reduced motion (the OS, the app override, a data-motion scope around the grid, or `reducedMotion`) keeps
 * a shallow dip (an opacity fade) and applies the height at once. A settle that interrupts another starts
 * from the current opacity and height. Calls made while a settle is still waiting to apply join it.
 */
export interface SettleGridOptions {
  /** `apply` changes the column count: a short opacity dip hides the reflow. Default false (height only). */
  reflow?: boolean;
  /** Forces reduced motion on or off; defaults to the OS setting, the app override and a scope around the grid. */
  reducedMotion?: boolean;
}

/** How far the grid dips while its columns change: deep with motion, shallow under reduced motion. */
const DIP_OPACITY = 0.2;
const REDUCED_DIP_OPACITY = 0.6;
/** Extra wait after a dip before applying anyway (an animation that never finishes, a throttled window). */
const FINISH_GRACE_MS = 50;

interface SettleRun {
  applies: Array<() => void>;
  /** The change is still waiting to apply (dipping out, or queued for the next microtask). */
  pending: boolean;
  animations: Animation[];
}

const runs = new WeakMap<HTMLElement, SettleRun>();

/** Layout height, without any scale transform on an ancestor. */
function layoutHeight(element: HTMLElement): number {
  const rect = element.getBoundingClientRect();
  const scale = element.offsetWidth > 0 ? rect.width / element.offsetWidth : 1;
  return scale > 0 ? rect.height / scale : rect.height;
}

function currentOpacity(element: HTMLElement): number {
  const value = Number.parseFloat(window.getComputedStyle(element).opacity);
  return Number.isFinite(value) ? value : 1;
}

/** Runs `callback` once, when `animation` finishes or after its duration (plus grace) at the latest. */
function afterAnimation(animation: Animation | null, durationMs: number, callback: () => void): void {
  let called = false;
  const run = () => {
    if (called) return;
    called = true;
    window.clearTimeout(timer);
    callback();
  };
  const timer = window.setTimeout(run, durationMs + FINISH_GRACE_MS);
  if (animation) animation.finished.then(run, () => undefined);
  else queueMicrotask(run);
}

function applySettle(grid: HTMLElement, run: SettleRun, before: number, opacity: number, reduced: boolean, dipOut: Animation | null): void {
  run.pending = false;
  // React state changes must reach the DOM before the new size is measured.
  flushSync(() => {
    for (const apply of run.applies.splice(0)) apply();
  });
  const after = layoutHeight(grid);
  if (opacity < 1) {
    const back = animateMotion(grid, [{ opacity }, { opacity: 1 }], { duration: "base", easing: "decelerate" });
    if (back) run.animations.push(back);
  }
  // Cancelled only once the way back holds the same opacity, so the grid never flashes.
  dipOut?.cancel();
  if (!reduced && Math.abs(after - before) > 1) {
    const height = animateMotion(grid, [
      { height: `${before}px`, overflow: "clip" },
      { height: `${after}px`, overflow: "clip" },
    ], { duration: "slow", easing: "emphasized" });
    if (height) run.animations.push(height);
  }
  void Promise.allSettled(run.animations.map((animation) => animation.finished)).then(() => {
    if (runs.get(grid) === run) runs.delete(grid);
  });
}

/**
 * Applies a grid's final layout once (see SettleGridOptions). `apply` makes the change: a React state update
 * (it runs inside `flushSync`, so call `settleGrid` from an effect or a handler, never during render) or a
 * direct DOM change. It always runs, even when the grid has no WAAPI or is detached.
 */
export function settleGrid(grid: HTMLElement, apply: () => void, { reflow = false, reducedMotion }: SettleGridOptions = {}): void {
  const current = runs.get(grid);
  if (current?.pending) {
    current.applies.push(apply);
    return;
  }
  const reduced = reducedMotion ?? (prefersReducedMotion() || grid.closest('[data-motion="reduced"]') !== null);
  const before = layoutHeight(grid);
  const from = currentOpacity(grid);
  for (const animation of current?.animations ?? []) animation.cancel();
  const run: SettleRun = { applies: [apply], pending: true, animations: [] };
  runs.set(grid, run);
  if (!reflow) {
    afterAnimation(null, 0, () => applySettle(grid, run, before, from, reduced, null));
    return;
  }
  const dip = Math.min(from, reduced ? REDUCED_DIP_OPACITY : DIP_OPACITY);
  const out = animateMotion(grid, [{ opacity: from }, { opacity: dip }], { duration: "exit-fast", easing: "accelerate", fill: "forwards" });
  if (out) run.animations.push(out);
  afterAnimation(out, out ? motionDuration("exit-fast") : 0, () => applySettle(grid, run, before, out ? dip : from, reduced, out));
}

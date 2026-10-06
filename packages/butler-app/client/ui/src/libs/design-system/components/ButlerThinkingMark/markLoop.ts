import { observeMark } from "./markObservers";
import { type ButlerMarkTheme, type ButlerMarkThemeColors } from "./butlerMarkTheme";
import { FRAME_INTERVAL_MS } from "./thinking-mark/constants";
import { createMarkRenderer } from "./markRenderer";
import { MorphSim } from "./thinking-mark/motion";

export interface MarkLoopInputs {
  theme?: ButlerMarkTheme;
  themeColors?: ButlerMarkThemeColors;
  isWorking: () => boolean;
  /** Effective reduced motion (prop, OS setting or DS scope): the still logo, no frame loop. */
  isReduced: () => boolean;
  sim: { current: MorphSim | null };
}

export interface MarkLoop {
  /** Wakes the loop after a state or prop change. */
  start: () => void;
  dispose: () => void;
}

/** One mark's frame step; returns false once the mark has nothing left to animate. */
type FrameStep = (time: number) => boolean;

/**
 * One requestAnimationFrame drives every moving mark on the page (the status
 * label, capsules, DS Viewer rows): N marks cost one frame callback, never N
 * loops, and the loop stops as soon as no mark is moving.
 */
const moving = new Set<FrameStep>();
let sharedFrame = 0;

function runFrame(time: number) {
  sharedFrame = 0;
  // Deleting the current entry while iterating a Set is safe and allocates nothing.
  for (const step of moving) if (!step(time)) moving.delete(step);
  if (moving.size > 0) sharedFrame = window.requestAnimationFrame(runFrame);
}

function wake(step: FrameStep) {
  moving.add(step);
  if (sharedFrame === 0) sharedFrame = window.requestAnimationFrame(runFrame);
}

function rest(step: FrameStep) {
  moving.delete(step);
  if (moving.size === 0 && sharedFrame !== 0) {
    window.cancelAnimationFrame(sharedFrame);
    sharedFrame = 0;
  }
}

/** Frame callbacks requested for marks right now (0 or 1); for tests and traces. */
export function pendingMarkFrames() {
  return sharedFrame === 0 ? 0 : 1;
}

/**
 * The mark's frame loop: draws only while the mark moves, and pauses when it
 * is offscreen, the document is hidden, or it has settled (idle logo, or
 * reduced motion). Layout is read on resize, never per frame.
 */
export function startMarkLoop(canvas: HTMLCanvasElement, inputs: MarkLoopInputs): MarkLoop | null {
  const renderer = createMarkRenderer(canvas, inputs);
  if (!renderer) return null;
  const { sim } = renderer;
  let lastFrame = 0;
  let stopped = false;
  let inView = true;
  const settled = () => inputs.isReduced() || (!inputs.isWorking() && sim.idle);
  const paused = () => stopped || !inView || document.visibilityState === "hidden";

  const tick = (time: number): boolean => {
    if (paused()) return false;
    if (inputs.isReduced()) {
      sim.park();
      renderer.draw();
      return false;
    }
    if (time - lastFrame >= FRAME_INTERVAL_MS) {
      renderer.render(time);
      lastFrame = time;
    }
    return !settled();
  };

  const startLoop = () => {
    if (moving.has(tick) || paused()) return;
    if (settled()) {
      if (inputs.isReduced()) sim.park();
      renderer.draw();
      return;
    }
    // After a pause the first step is one frame long, not the time spent paused.
    sim.clock = 0;
    wake(tick);
  };

  const stopLoop = () => rest(tick);

  const disposeObservers = observeMark(canvas, {
    implicitTheme: !inputs.theme,
    theme: renderer.theme,
    resize: renderer.resize,
    intersection(visible) { inView = visible; if (inView) startLoop(); else stopLoop(); },
    visibility() { if (document.visibilityState === "hidden") stopLoop(); else startLoop(); },
  });
  renderer.resize();
  startLoop();

  return {
    start: startLoop,
    dispose: () => {
      stopped = true;
      stopLoop();
      disposeObservers();
    },
  };
}

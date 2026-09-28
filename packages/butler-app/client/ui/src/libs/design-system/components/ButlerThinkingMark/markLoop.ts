import { type ButlerMarkTheme, type ButlerMarkThemeColors, inkForButlerMarkTheme, RISO_INKS } from "./butlerMarkTheme";
import { DESIGN_SIZE, FRAME_INTERVAL_MS, MAX_STEP_S } from "./thinking-mark/constants";
import { createSurface, drawFrame, resizeSurface } from "./thinking-mark/canvas-drawing";
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

/** Nearest theme scope (DS Viewer frames, app body), then the OS color scheme. */
function resolveTheme(element: Element): ButlerMarkTheme {
  const scope = element.closest(".theme-dark, .theme-light");
  if (scope) return scope.classList.contains("theme-dark") ? "dark" : "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * The mark's frame loop: draws only while the mark moves, and pauses when it
 * is offscreen, the document is hidden, or it has settled (idle logo, or
 * reduced motion). Layout is read on resize, never per frame.
 */
export function startMarkLoop(canvas: HTMLCanvasElement, inputs: MarkLoopInputs): MarkLoop | null {
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return null;

  const sim = (inputs.sim.current ??= new MorphSim());
  const theme = inputs.theme ?? resolveTheme(canvas);
  const surface = createSurface(ctx, inkForButlerMarkTheme(theme, inputs.themeColors), RISO_INKS[theme]);
  let lastFrame = 0;
  let stopped = false;
  let inView = true;
  const settled = () => inputs.isReduced() || (!inputs.isWorking() && sim.idle);
  const paused = () => stopped || !inView || document.visibilityState === "hidden";

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const side = Math.max(1, Math.min(rect.width, rect.height || rect.width));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelSide = Math.round(side * dpr);
    resizeSurface(surface, pixelSide, pixelSide / DESIGN_SIZE, side);
  };

  const render = (time: number) => {
    // A simulation shared by several marks (see morphKey) advances once per frame.
    if (sim.clock !== time) {
      const dt = sim.clock > 0 ? Math.min((time - sim.clock) / 1000, MAX_STEP_S) : 1 / 60;
      sim.clock = time;
      sim.update(dt, inputs.isWorking());
    }
    drawFrame(surface, sim, false);
  };

  const tick = (time: number): boolean => {
    if (paused()) return false;
    if (inputs.isReduced()) {
      sim.park();
      drawFrame(surface, sim, true);
      return false;
    }
    if (time - lastFrame >= FRAME_INTERVAL_MS) {
      render(time);
      lastFrame = time;
    }
    return !settled();
  };

  const startLoop = () => {
    if (moving.has(tick) || paused()) return;
    if (settled()) {
      if (inputs.isReduced()) sim.park();
      drawFrame(surface, sim, inputs.isReduced());
      return;
    }
    // After a pause the first step is one frame long, not the time spent paused.
    sim.clock = 0;
    wake(tick);
  };

  const stopLoop = () => rest(tick);

  const resizeAndRender = () => {
    resize();
    drawFrame(surface, sim, inputs.isReduced());
  };
  const resizeObserver = new ResizeObserver(resizeAndRender);
  resizeObserver.observe(canvas);
  // Offscreen marks (scrolled-away history, collapsed panels) stop drawing.
  const intersectionObserver = new IntersectionObserver((entries) => {
    inView = entries.some((entry) => entry.isIntersecting);
    if (inView) startLoop();
    else stopLoop();
  });
  intersectionObserver.observe(canvas);
  const handleVisibilityChange = () => {
    if (document.visibilityState === "hidden") stopLoop();
    else startLoop();
  };
  document.addEventListener("visibilitychange", handleVisibilityChange);
  resizeAndRender();
  startLoop();

  return {
    start: startLoop,
    dispose: () => {
      stopped = true;
      stopLoop();
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    },
  };
}

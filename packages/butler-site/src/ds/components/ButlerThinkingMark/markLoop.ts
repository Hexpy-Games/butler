/* Forked from the app DS ButlerThinkingMark/markLoop.ts; theme resolution reads :root[data-theme]. */
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

/** The page's explicit theme (:root[data-theme]), then the OS color scheme (web fork). */
function resolveTheme(): ButlerMarkTheme {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "dark" || explicit === "light") return explicit;
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
  const theme = inputs.theme ?? resolveTheme();
  const surface = createSurface(ctx, inkForButlerMarkTheme(theme, inputs.themeColors), RISO_INKS[theme]);
  let animationFrame = 0;
  let lastFrame = 0;
  let lastRenderTime = 0;
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

  const render = (time = performance.now()) => {
    const dt = lastRenderTime > 0 ? Math.min((time - lastRenderTime) / 1000, MAX_STEP_S) : 1 / 60;
    lastRenderTime = time;
    sim.update(dt, inputs.isWorking());
    drawFrame(surface, sim, false);
  };

  const tick = (time: number) => {
    animationFrame = 0;
    if (paused()) return;
    if (inputs.isReduced()) {
      sim.park();
      drawFrame(surface, sim, true);
      return;
    }
    if (time - lastFrame >= FRAME_INTERVAL_MS) {
      render(time);
      lastFrame = time;
    }
    if (settled()) return;
    animationFrame = window.requestAnimationFrame(tick);
  };

  const startLoop = () => {
    if (animationFrame !== 0 || paused()) return;
    if (settled()) {
      if (inputs.isReduced()) sim.park();
      drawFrame(surface, sim, inputs.isReduced());
      return;
    }
    lastRenderTime = 0;
    animationFrame = window.requestAnimationFrame(tick);
  };

  const stopLoop = () => {
    window.cancelAnimationFrame(animationFrame);
    animationFrame = 0;
  };

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

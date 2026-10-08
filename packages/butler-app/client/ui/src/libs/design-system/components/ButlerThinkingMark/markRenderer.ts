import { inkForButlerMarkTheme, RISO_INKS, type ButlerMarkTheme } from "./butlerMarkTheme";
import { DESIGN_SIZE, MAX_STEP_S } from "./thinking-mark/constants";
import { createSurface, drawFrame, resizeSurface } from "./thinking-mark/canvas-drawing";
import { MorphSim } from "./thinking-mark/motion";
import type { MarkLoopInputs } from "./markLoop";

export function resolveMarkTheme(element: Element): ButlerMarkTheme {
  const scope = element.closest(".theme-dark, .theme-light");
  if (scope) return scope.classList.contains("theme-dark") ? "dark" : "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Own canvas geometry and inks; the frame scheduler owns visibility and wakeups. */
export function createMarkRenderer(canvas: HTMLCanvasElement, inputs: MarkLoopInputs) {
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return null;
  const sim = (inputs.sim.current ??= new MorphSim());
  const theme = inputs.theme ?? resolveMarkTheme(canvas);
  const riso = (next: ButlerMarkTheme) => inputs.inks?.(next) ?? RISO_INKS[next];
  let surface = createSurface(ctx, inkForButlerMarkTheme(theme, inputs.themeColors), riso(theme));
  const draw = () => drawFrame(surface, sim, inputs.isReduced());
  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const side = Math.max(1, Math.min(rect.width, rect.height || rect.width));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelSide = Math.round(side * dpr);
    resizeSurface(surface, pixelSide, pixelSide / DESIGN_SIZE, side);
    draw();
  };
  return {
    sim, draw, resize,
    theme() {
      const next = resolveMarkTheme(canvas);
      surface = createSurface(ctx, inkForButlerMarkTheme(next, inputs.themeColors), riso(next));
      resize();
    },
    render(time: number) {
      if (sim.clock !== time) {
        const dt = sim.clock > 0 ? Math.min((time - sim.clock) / 1000, MAX_STEP_S) : 1 / 60;
        sim.clock = time;
        sim.update(dt, inputs.isWorking());
      }
      drawFrame(surface, sim, false);
    },
  };
}

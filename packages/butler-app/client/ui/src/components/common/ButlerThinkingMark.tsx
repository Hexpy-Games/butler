import { useEffect, useRef } from "react";
import { AspectFrame, type IconSize } from "@/butler-ds";
import {
  type ButlerMarkTheme,
  type ButlerMarkThemeColors,
  inkForButlerMarkTheme,
  RISO_INKS,
} from "./butlerMarkTheme.ts";
import { DESIGN_SIZE } from "./thinking-mark/constants";
import { createSurface, drawFrame, resizeSurface } from "./thinking-mark/canvas-drawing";
import { MorphSim } from "./thinking-mark/motion";

type ButlerThinkingMarkVariant = ButlerMarkTheme;
export type ButlerThinkingMarkState = "idle" | "working";

interface ButlerThinkingMarkProps {
  active?: boolean;
  /** Forces reduced motion on or off; defaults to the OS preference. */
  reducedMotion?: boolean;
  /** Fixed icon size; omit to fill the container width. */
  size?: IconSize;
  state?: ButlerThinkingMarkState;
  theme?: ButlerMarkTheme;
  themeColors?: ButlerMarkThemeColors;
  variant?: ButlerThinkingMarkVariant;
}

export function ButlerThinkingMark({
  active = true,
  reducedMotion,
  size,
  state,
  theme,
  themeColors,
  variant = "dark",
}: ButlerThinkingMarkProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const resolvedState = state ?? (active ? "working" : "idle");
  const resolvedTheme = theme ?? variant;
  const stateRef = useRef<ButlerThinkingMarkState>(resolvedState);
  const simRef = useRef<MorphSim | null>(null);
  const reducedRef = useRef(reducedMotion);
  const startLoopRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    stateRef.current = resolvedState;
    reducedRef.current = reducedMotion;
    startLoopRef.current();
  }, [resolvedState, reducedMotion]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return undefined;

    const sim = (simRef.current ??= new MorphSim());
    const surface = createSurface(ctx, inkForButlerMarkTheme(resolvedTheme, themeColors), RISO_INKS[resolvedTheme]);
    let animationFrame = 0;
    let lastFrame = 0;
    let lastRenderTime = 0;
    let stopped = false;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const isReduced = () => reducedRef.current ?? media.matches;
    const isWorking = () => stateRef.current === "working";
    const settled = () => (isReduced() ? sim.reducedSettled(isWorking()) : !isWorking() && sim.idle);

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const side = Math.max(1, Math.min(rect.width, rect.height || rect.width));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const pixelSide = Math.round(side * dpr);
      resizeSurface(surface, pixelSide, pixelSide / DESIGN_SIZE, side);
    };

    const render = (time = performance.now()) => {
      const dt = lastRenderTime > 0 ? Math.min((time - lastRenderTime) / 1000, 0.05) : 1 / 60;
      lastRenderTime = time;
      if (isReduced()) sim.updateReduced(dt, isWorking());
      else sim.update(dt, isWorking());
      drawFrame(surface, sim, isReduced());
    };

    const tick = (time: number) => {
      if (stopped) return;
      if (document.visibilityState === "hidden") {
        animationFrame = 0;
        return;
      }
      if (time - lastFrame >= 1000 / 60 - 2) {
        render(time);
        lastFrame = time;
      }
      if (settled()) {
        animationFrame = 0;
        return;
      }
      animationFrame = window.requestAnimationFrame(tick);
    };

    const startLoop = () => {
      if (animationFrame !== 0) return;
      if (settled()) {
        drawFrame(surface, sim, isReduced());
        return;
      }
      lastRenderTime = 0;
      animationFrame = window.requestAnimationFrame(tick);
    };

    const resizeAndRender = () => {
      resize();
      drawFrame(surface, sim, isReduced());
    };
    const observer = new ResizeObserver(resizeAndRender);
    observer.observe(canvas);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = 0;
        return;
      }
      startLoop();
    };

    startLoopRef.current = startLoop;
    media.addEventListener("change", startLoop);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    resizeAndRender();
    startLoop();

    return () => {
      stopped = true;
      startLoopRef.current = () => undefined;
      window.cancelAnimationFrame(animationFrame);
      observer.disconnect();
      media.removeEventListener("change", startLoop);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [resolvedTheme, themeColors?.dark, themeColors?.light]);

  return (
    <AspectFrame size={size} aria-hidden="true">
      <canvas ref={canvasRef} />
    </AspectFrame>
  );
}

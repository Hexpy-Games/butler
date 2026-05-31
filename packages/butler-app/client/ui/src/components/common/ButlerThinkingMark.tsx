import { type CSSProperties, useEffect, useRef } from "react";
import {
  type ButlerMarkTheme,
  type ButlerMarkThemeColors,
  inkForButlerMarkTheme,
} from "./butlerMarkTheme.ts";
import { DESIGN_SIZE } from "./thinking-mark/constants";
import { drawMark } from "./thinking-mark/canvas-drawing";

type ButlerThinkingMarkVariant = ButlerMarkTheme;
export type ButlerThinkingMarkState = "idle" | "working";

interface ButlerThinkingMarkProps {
  active?: boolean;
  className?: string;
  state?: ButlerThinkingMarkState;
  style?: CSSProperties;
  theme?: ButlerMarkTheme;
  themeColors?: ButlerMarkThemeColors;
  variant?: ButlerThinkingMarkVariant;
}

export function ButlerThinkingMark({
  active = true,
  className,
  state,
  style,
  theme,
  themeColors,
  variant = "dark",
}: ButlerThinkingMarkProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const resolvedState = state ?? (active ? "working" : "idle");
  const resolvedTheme = theme ?? variant;
  const stateRef = useRef<ButlerThinkingMarkState>(resolvedState);
  const morphRef = useRef(resolvedState === "working" ? 1 : 0);
  const waveStartedAtRef = useRef(Date.now());

  useEffect(() => {
    stateRef.current = resolvedState;
    window.dispatchEvent(new Event("butler-thinking-mark-state-change"));
  }, [resolvedState]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return undefined;

    let animationFrame = 0;
    let lastFrame = 0;
    let lastRenderTime = 0;
    let stopped = false;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const ink = inkForButlerMarkTheme(resolvedTheme, themeColors);

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const side = Math.max(1, Math.min(rect.width, rect.height || rect.width));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const pixelSide = Math.round(side * dpr);
      if (canvas.width !== pixelSide || canvas.height !== pixelSide) {
        canvas.width = pixelSide;
        canvas.height = pixelSide;
      }
      ctx.setTransform(pixelSide / DESIGN_SIZE, 0, 0, pixelSide / DESIGN_SIZE, 0, 0);
    };

    const render = (time = performance.now()) => {
      resize();
      const delta = lastRenderTime > 0 ? Math.min(time - lastRenderTime, 100) : 16;
      const target = stateRef.current === "working" && !media.matches ? 1 : 0;
      const transitionAmount = 1 - Math.exp(-delta / 220);
      morphRef.current += (target - morphRef.current) * transitionAmount;
      if (Math.abs(target - morphRef.current) < 0.002) morphRef.current = target;
      lastRenderTime = time;

      const t = Date.now() - waveStartedAtRef.current;
      drawMark(ctx, t, media.matches ? 0 : morphRef.current, ink);
    };

    const tick = (time: number) => {
      if (stopped) return;
      if (document.visibilityState === "hidden") {
        animationFrame = window.requestAnimationFrame(tick);
        return;
      }
      if (time - lastFrame >= 1000 / 60) {
        render(time);
        lastFrame = time;
      }
      const isSettledIdle = stateRef.current === "idle" && morphRef.current === 0;
      if (isSettledIdle || media.matches) {
        animationFrame = 0;
        return;
      }
      animationFrame = window.requestAnimationFrame(tick);
    };

    const startLoop = () => {
      if (media.matches) return;
      if (animationFrame !== 0) window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(tick);
    };

    const observer = new ResizeObserver(() => render());
    observer.observe(canvas);
    const handleMediaChange = () => {
      render();
      startLoop();
    };
    const handleStateChange = () => startLoop();

    media.addEventListener("change", handleMediaChange);
    window.addEventListener("butler-thinking-mark-state-change", handleStateChange);
    render();
    startLoop();

    return () => {
      stopped = true;
      window.cancelAnimationFrame(animationFrame);
      observer.disconnect();
      media.removeEventListener("change", handleMediaChange);
      window.removeEventListener("butler-thinking-mark-state-change", handleStateChange);
    };
  }, [resolvedTheme, themeColors?.dark, themeColors?.light]);

  return (
    <span
      className={className}
      style={{
        display: "block",
        maxWidth: "100%",
        aspectRatio: 1,
        contain: "layout paint size",
        ...style,
      }}
      aria-hidden="true"
    >
      <canvas
        ref={canvasRef}
        style={{ display: "block", width: "100%", height: "100%" }}
      />
    </span>
  );
}

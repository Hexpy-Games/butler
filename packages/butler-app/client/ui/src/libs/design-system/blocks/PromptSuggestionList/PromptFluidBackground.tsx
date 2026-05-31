import { useEffect, useRef } from "react";
import {
  createFluidRenderer,
  type FluidPalette,
  type FluidTone,
  type FluidVariant,
} from "./promptFluid";
import styles from "./PromptSuggestionList.module.css";

const FRAME_INTERVAL_MS = 1000 / 20;

interface PromptFluidBackgroundProps {
  palette?: FluidPalette;
  tone?: FluidTone;
  variant?: FluidVariant;
}

export function PromptFluidBackground({
  palette,
  tone = "light",
  variant = "bloom",
}: PromptFluidBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const renderer = createFluidRenderer(canvas, palette, tone, variant);
    if (!renderer) return undefined;

    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    let animationFrame = 0;
    let lastFrame = 0;
    let stopped = false;

    const draw = (time = performance.now()) => {
      renderer.draw(time);
    };

    const tick = (time: number) => {
      if (stopped) return;
      if (
        document.visibilityState !== "hidden" &&
        time - lastFrame >= FRAME_INTERVAL_MS
      ) {
        draw(time);
        lastFrame = time;
      }
      animationFrame = window.requestAnimationFrame(tick);
    };

    const start = () => {
      window.cancelAnimationFrame(animationFrame);
      draw();
      if (!media.matches) animationFrame = window.requestAnimationFrame(tick);
    };

    const resizeObserver = new ResizeObserver(() => draw());
    resizeObserver.observe(canvas);
    media.addEventListener("change", start);
    document.addEventListener("visibilitychange", start);
    start();

    return () => {
      stopped = true;
      window.cancelAnimationFrame(animationFrame);
      renderer.dispose();
      resizeObserver.disconnect();
      media.removeEventListener("change", start);
      document.removeEventListener("visibilitychange", start);
    };
  }, [palette, tone, variant]);

  return (
    <canvas
      aria-hidden="true"
      className={styles.fluidBackground}
      data-test-class="new-chat-fluid-gradient"
      ref={canvasRef}
    />
  );
}

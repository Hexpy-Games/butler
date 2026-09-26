import { useEffect, useRef } from "react";
import { AspectFrame } from "../AspectFrame";
import type { IconSize } from "../Icons";
import type { ButlerMarkTheme, ButlerMarkThemeColors } from "./butlerMarkTheme";
import { startMarkLoop, type MarkLoop } from "./markLoop";
import type { MorphSim } from "./thinking-mark/motion";

export type ButlerThinkingMarkState = "idle" | "working";

export interface ButlerThinkingMarkProps {
  /** `idle` draws the filled logo; `working` runs the riso halftone animation. Flip it on one mounted mark. */
  state?: ButlerThinkingMarkState;
  /** Fixed square size from `--icon-size-*`; omit to fill the container width. */
  size?: IconSize;
  /** Ink set for the surface; omit to follow the nearest `.theme-dark` / `.theme-light` scope. */
  theme?: ButlerMarkTheme;
  /** Overrides the key ink per theme. */
  themeColors?: ButlerMarkThemeColors;
  /** Forces reduced motion on or off; defaults to the OS setting and the DS reduced-motion scope. */
  reducedMotion?: boolean;
  "data-test-class"?: string;
}

/**
 * Butler's identity mark and its thinking animation (riso halftone canvas).
 * Idle is the exact filled logo; working morphs into a lit halftone moon and
 * settles back to the logo when work ends. The frame loop (markLoop.ts) runs
 * only while the mark moves and is on screen; reduced motion breathes the
 * logo in opacity on DS motion tokens.
 */
export function ButlerThinkingMark({
  state = "idle",
  size,
  theme,
  themeColors,
  reducedMotion,
  "data-test-class": dataTestClass,
}: ButlerThinkingMarkProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<ButlerThinkingMarkState>(state);
  const reducedRef = useRef(reducedMotion);
  // The simulation outlives theme changes so a re-theme never restarts the morph.
  const simRef = useRef<MorphSim | null>(null);
  const loopRef = useRef<MarkLoop | null>(null);

  useEffect(() => {
    stateRef.current = state;
    reducedRef.current = reducedMotion;
    loopRef.current?.start();
  }, [state, reducedMotion]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const loop = startMarkLoop(canvas, {
      theme,
      themeColors,
      isWorking: () => stateRef.current === "working",
      forcedReduced: () => reducedRef.current,
      sim: simRef,
    });
    loopRef.current = loop;
    return () => {
      loopRef.current = null;
      loop?.dispose();
    };
    // Only the ink inputs rebuild the surface; state flows through refs.
  }, [theme, themeColors?.dark, themeColors?.light]);

  return (
    <AspectFrame size={size} aria-hidden="true" data-mark-state={state} data-test-class={dataTestClass}>
      <canvas ref={canvasRef} />
    </AspectFrame>
  );
}

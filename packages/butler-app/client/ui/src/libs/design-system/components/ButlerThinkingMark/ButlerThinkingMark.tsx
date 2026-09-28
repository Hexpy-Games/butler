import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { prefersReducedMotion, subscribeReducedMotion } from "../../lib/motion";
import { AspectFrame } from "../AspectFrame";
import type { IconSize } from "../Icons";
import type { ButlerMarkTheme, ButlerMarkThemeColors } from "./butlerMarkTheme";
import styles from "./ButlerThinkingMark.module.css";
import { startMarkLoop, type MarkLoop } from "./markLoop";
import { holdMorph } from "./morphContinuity";
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
  /**
   * Marks that stand for the same ongoing work share a key: when the product
   * remounts the mark mid-work (pending -> current status), the new mark
   * continues the morph instead of restarting it from the logo.
   */
  morphKey?: string;
  "data-test-class"?: string;
}

function useSystemReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => subscribeReducedMotion(setReduced), []);
  return reduced;
}

/**
 * Butler's identity mark and its thinking animation (riso halftone canvas).
 * Idle is the exact filled logo; working morphs into a lit halftone moon and
 * settles back to the logo when work ends. The frame loop (markLoop.ts) runs
 * only while the mark moves and is on screen. Reduced motion stops the loop and
 * breathes the still logo in CSS on the Spinner's reduced pulse.
 */
export function ButlerThinkingMark({
  state = "idle",
  size,
  theme,
  themeColors,
  reducedMotion,
  morphKey,
  "data-test-class": dataTestClass,
}: ButlerThinkingMarkProps) {
  const systemReduced = useSystemReducedMotion();
  const reduced = reducedMotion ?? systemReduced;
  const breathing = reduced && state === "working";
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<ButlerThinkingMarkState>(state);
  const reducedRef = useRef(reduced);
  // The simulation outlives theme changes (and, with a morphKey, remounts) so neither restarts the morph.
  const simRef = useRef<MorphSim | null>(null);
  const loopRef = useRef<MarkLoop | null>(null);
  const [breathe, setBreathe] = useState<"on" | "settle" | undefined>(breathing ? "on" : undefined);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (breathing) {
      setBreathe("on");
    } else if (canvas && breathe === "on") {
      // Settle from wherever the breathe is, not from a jump back to 1.
      canvas.style.setProperty("--thinking-mark-breathe-from", getComputedStyle(canvas).opacity);
      setBreathe("settle");
    }
    // Only the breathing edge matters; `breathe` is read, not tracked.
  }, [breathing]);

  useEffect(() => {
    stateRef.current = state;
    reducedRef.current = reduced;
    loopRef.current?.start();
  }, [state, reduced]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const release = holdMorph(morphKey, simRef);
    const loop = startMarkLoop(canvas, {
      theme,
      themeColors,
      isWorking: () => stateRef.current === "working",
      isReduced: () => reducedRef.current,
      sim: simRef,
    });
    loopRef.current = loop;
    return () => {
      loopRef.current = null;
      loop?.dispose();
      release();
    };
  }, [theme, themeColors?.dark, themeColors?.light, morphKey]);

  return (
    <AspectFrame size={size} aria-hidden="true" data-mark-state={state} data-test-class={dataTestClass}>
      <canvas ref={canvasRef} className={styles.canvas} data-breathe={breathe}
        onAnimationEnd={() => setBreathe((current) => (current === "settle" ? undefined : current))} />
    </AspectFrame>
  );
}

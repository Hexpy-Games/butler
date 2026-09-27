import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { prefersReducedMotion, subscribeReducedMotion } from "../../lib/motion";
import type { ButlerMarkTheme } from "./butlerMarkTheme";
import { ButlerMarkLogo } from "./ButlerMarkLogo";
import styles from "./ButlerThinkingMark.module.css";
import { startMarkLoop, type MarkLoop } from "./markLoop";
import type { MorphSim } from "./thinking-mark/motion";

export type ButlerThinkingMarkState = "idle" | "working";

export interface ButlerThinkingMarkProps {
  /** `idle` draws the filled logo; `working` runs the riso halftone animation. Flip it on one mounted mark. */
  state?: ButlerThinkingMarkState;
  /** Fixed square size from `--icon-size-*`; omit to fill the container width. */
  size?: "md" | "lg" | "xl" | "2xl";
  /** Ink set for the surface; omit to follow :root[data-theme] and then the OS scheme. */
  theme?: ButlerMarkTheme;
  /** Forces reduced motion on or off; defaults to the OS setting. */
  reducedMotion?: boolean;
}

function useSystemReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    setReduced(prefersReducedMotion());
    return subscribeReducedMotion(setReduced);
  }, []);
  return reduced;
}

/**
 * Butler's identity mark and its thinking animation (riso halftone canvas),
 * forked from the app DS. Idle is the exact filled logo; working morphs into
 * a lit halftone moon. The frame loop runs only while the mark moves and is
 * on screen; reduced motion stops it and breathes the still logo in CSS.
 */
export function ButlerThinkingMark({ state = "idle", size, theme, reducedMotion }: ButlerThinkingMarkProps) {
  const systemReduced = useSystemReducedMotion();
  const reduced = reducedMotion ?? systemReduced;
  const breathing = reduced && state === "working";
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<ButlerThinkingMarkState>(state);
  const reducedRef = useRef(reduced);
  // The simulation outlives theme changes so a re-theme never restarts the morph.
  const simRef = useRef<MorphSim | null>(null);
  const loopRef = useRef<MarkLoop | null>(null);
  const [ready, setReady] = useState(false);
  const [breathe, setBreathe] = useState<"on" | "settle" | undefined>(undefined);

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
    const loop = startMarkLoop(canvas, {
      theme,
      isWorking: () => stateRef.current === "working",
      isReduced: () => reducedRef.current,
      sim: simRef,
    });
    loopRef.current = loop;
    setReady(loop !== null);
    return () => {
      loopRef.current = null;
      loop?.dispose();
    };
  }, [theme]);

  return (
    <span aria-hidden="true" className={styles.frame} data-mark-state={state} data-ready={ready ? "true" : undefined} data-size={size}>
      <ButlerMarkLogo />
      <canvas
        className={styles.canvas}
        data-breathe={breathe}
        onAnimationEnd={() => setBreathe((current) => (current === "settle" ? undefined : current))}
        ref={canvasRef}
      />
    </span>
  );
}

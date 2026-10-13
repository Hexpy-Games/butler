import type { ReactNode } from "react";
import type { IconButtonTone } from "../../components/IconButton/IconButton";
import { useReducedMotion } from "../../lib/useReducedMotion";
import styles from "./ActivityGlow.module.css";

/**
 * What Butler is doing with the thing the wrapped button opens:
 * `busy` a rotating, breathing riso ring; `attention` (needs the user) an
 * amber halo that pulses twice on entry, then holds, plus an amber dot;
 * `error` a red dot; `idle` nothing.
 */
export type ActivityGlowState = "idle" | "busy" | "attention" | "error";

export interface ActivityGlowProps {
  state: ActivityGlowState;
  /** One `IconButton`; its label carries the state for assistive tech. */
  children: ReactNode;
  /** Forces reduced motion on or off; defaults to the OS setting and the DS reduced-motion scope. */
  reducedMotion?: boolean;
  "data-test-class"?: string;
}

/**
 * The icon tone that goes with a state: the riso stroke while busy, the
 * Butler ink while the surface the button opens is open, default otherwise.
 */
export function activityGlowTone(state: ActivityGlowState, open = false): IconButtonTone {
  if (open) return "butler";
  return state === "busy" ? "riso" : "default";
}

/**
 * A halo and a status dot around an `IconButton` (the titlebar browser
 * toggle while Butler browses in the background). The button itself is
 * untouched. Reduced motion shows only the dots: busy becomes the riso dot.
 */
export function ActivityGlow({ state, children, reducedMotion, "data-test-class": dataTestClass }: ActivityGlowProps) {
  const systemReduced = useReducedMotion();
  const reduced = reducedMotion ?? systemReduced;
  const halo = !reduced && (state === "busy" || state === "attention");
  const dot = state === "attention" || state === "error" || (reduced && state === "busy");
  return (
    <span className={styles.root} data-slot="activity-glow" data-state={state} data-reduced={reduced ? "true" : undefined}
      data-test-class={dataTestClass}>
      {halo ? (
        <span className={styles.halo} data-slot="activity-glow-halo" aria-hidden="true">
          <span className={styles.ring} />
        </span>
      ) : null}
      {children}
      {dot ? <span className={styles.dot} data-slot="activity-glow-dot" aria-hidden="true" /> : null}
    </span>
  );
}

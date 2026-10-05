import { useEffect, useRef, type RefObject } from "react";
import { animateMotion, prefersReducedMotion, subscribeReducedMotion } from "@/butler-ds";

/**
 * Pulse keyframes: transform only (compositor), DS duration/easing tokens. The scrim never
 * animates, so the measured contrast floor holds at every frame of the pulse.
 */
export const PULSE = {
  /** The scene swells 2.5% from its bottom edge, like a wave arriving. */
  art: [{ transform: "scale(1)" }, { transform: "scale(1.025)", offset: 0.35 }, { transform: "scale(1)" }],
  /** The character's head peeks up 3px. */
  head: [{ transform: "translateY(0)" }, { transform: "translateY(-3px)", offset: 0.4 }, { transform: "translateY(0)" }],
  duration: "deliberate",
  easing: "standard",
  /** A new pulse starts only once the running one has passed this share; faster typing coalesces. */
  restartAfter: 0.5,
} as const;

export interface PulseMeter {
  /** Input handler cost (ms), last 128 keystrokes. */
  input: number[];
  /** Pulse frame cost (ms): the rAF callback that starts the animations. */
  frame: number[];
  /** Local scrim frame cost (ms): text-line/control measurement + halo placement. */
  scrim: number[];
  /** Local scrim frames after open/close or a resize (control groups re-read), not on the typing path. */
  relayout: number[];
  pulses: number;
}

function sample(values: number[], value: number) {
  if (values.length === 128) values.shift();
  values.push(value);
}

/**
 * Keystroke → at most one pulse per frame. The input handler only sets a flag and asks for a
 * frame (no DOM read, no React state, no text access). The frame starts compositor animations
 * through the DS `animateMotion` (one call per target). Reduced motion: no pulse at all (the
 * scene is a still frame). rAF does not run while the document is hidden, so a hidden window
 * never pulses.
 */
export function useTypingPulse(
  host: RefObject<HTMLElement | null>,
  targets: { art: RefObject<HTMLElement | null>; head: RefObject<HTMLElement | null> },
  enabled: boolean,
  meter: RefObject<PulseMeter>,
) {
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  useEffect(() => {
    const element = host.current;
    if (!element || !enabled) return undefined;
    let reduced = prefersReducedMotion();
    const unsubscribe = subscribeReducedMotion((value) => { reduced = value; });
    let frame = 0;
    let running: Animation | null = null;
    const fire = () => {
      frame = 0;
      const start = performance.now();
      const progress = running?.effect?.getComputedTiming().progress;
      if (running?.playState === "running" && progress != null && progress < PULSE.restartAfter) return;
      const { art, head } = targetsRef.current;
      const options = { duration: PULSE.duration, easing: PULSE.easing } as const;
      const swell = art.current ? animateMotion(art.current, [...PULSE.art], options) : null;
      const peek = head.current ? animateMotion(head.current, [...PULSE.head], options) : null;
      running = swell ?? peek;
      meter.current.pulses += 1;
      sample(meter.current.frame, performance.now() - start);
    };
    const onInput = () => {
      const start = performance.now();
      if (!reduced && !frame) frame = requestAnimationFrame(fire);
      sample(meter.current.input, performance.now() - start);
    };
    element.addEventListener("input", onInput);
    return () => {
      element.removeEventListener("input", onInput);
      cancelAnimationFrame(frame);
      unsubscribe();
    };
  }, [host, enabled, meter]);
}

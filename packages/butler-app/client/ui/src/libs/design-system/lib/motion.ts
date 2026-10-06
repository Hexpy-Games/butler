import { createStore } from "zustand/vanilla";
import { subscribeWithSelector } from "zustand/middleware";
/**
 * The one WAAPI entry point (DS spec Motion Contract). Timing comes from the
 * --motion-* tokens and reduced motion turns every animation into an opacity
 * fade. Product code and DS components call animateMotion() instead of
 * element.animate(); the motion lint enforces it.
 */

export type MotionDurationName =
  | "instant"
  | "menu"
  | "fast"
  | "base"
  | "slow"
  | "deliberate"
  | "exit-menu"
  | "exit-fast"
  | "exit-base"
  | "exit-slow";

export type MotionEasingName =
  | "standard"
  | "decelerate"
  | "accelerate"
  | "emphasized"
  | "spring"
  | "linear";

/** Mirrors tokens.css; used when the token stylesheet is not loaded. */
const DURATION_FALLBACK: Record<MotionDurationName, number> = {
  instant: 60,
  menu: 90,
  fast: 120,
  base: 160,
  slow: 220,
  deliberate: 320,
  "exit-menu": 60,
  "exit-fast": 90,
  "exit-base": 110,
  "exit-slow": 150,
};

const EASING_FALLBACK: Record<MotionEasingName, string> = {
  standard: "cubic-bezier(0.2, 0, 0, 1)",
  decelerate: "cubic-bezier(0, 0, 0, 1)",
  accelerate: "cubic-bezier(0.3, 0, 1, 1)",
  emphasized: "cubic-bezier(0.2, 0.8, 0.2, 1)",
  spring: "cubic-bezier(0.2, 0.8, 0.2, 1)",
  linear: "linear",
};

const TRANSFORM_KEYS = new Set(["transform", "translate", "scale", "rotate", "offset", "offsetPath", "offsetDistance"]);

function tokenValue(name: string): string {
  if (typeof window === "undefined" || typeof document === "undefined") return "";
  try {
    return window.getComputedStyle((document.getElementById?.("root") ?? document.documentElement)).getPropertyValue(name).trim();
  } catch {
    return "";
  }
}

/** The app shell is the CSS boundary; the viewer retains its local scope. */
export function setReducedMotionOverride(reduced: boolean): void {
  if (typeof document === "undefined") return;
  const shell = document.getElementById?.("root") ?? document.documentElement;
  if (reduced) shell.dataset.motion = "reduced";
  else delete shell.dataset.motion;
  publishReducedMotion();
}

function reducedMotionScope(): boolean {
  return typeof document !== "undefined" && (
    document.getElementById?.("root")?.dataset.motion === "reduced" ||
    document.documentElement?.dataset?.motion === "reduced" || document.body?.dataset?.motion === "reduced"
  );
}

export function prefersReducedMotion(): boolean {
  if (reducedMotionScope()) return true;
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const motionState = createStore(subscribeWithSelector(() => ({ reduced: false })));
let stopMotionSignals: (() => void) | undefined;
let motionSubscribers = 0;

function publishReducedMotion(): void {
  motionState.setState({ reduced: prefersReducedMotion() });
}

/** One shared observer and OS listener; selector notifications only on a change. */
export function subscribeReducedMotion(callback: (reduced: boolean) => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  if (!motionSubscribers++) {
    publishReducedMotion();
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    media.addEventListener("change", publishReducedMotion);
    const observer = typeof MutationObserver === "function" ? new MutationObserver(publishReducedMotion) : null;
    for (const node of [document.getElementById?.("root"), document.body, document.documentElement]) {
      if (node) observer?.observe(node, { attributes: true, attributeFilter: ["data-motion"] });
    }
    stopMotionSignals = () => { media.removeEventListener("change", publishReducedMotion); observer?.disconnect(); };
  }
  const unsubscribe = motionState.subscribe((state) => state.reduced, callback);
  return () => {
    unsubscribe();
    if (!--motionSubscribers) { stopMotionSignals?.(); stopMotionSignals = undefined; }
  };
}

export function motionDuration(name: MotionDurationName): number {
  const raw = tokenValue(`--motion-${name}`);
  const match = /^(\d*\.?\d+)(ms|s)$/u.exec(raw);
  if (!match) return DURATION_FALLBACK[name];
  return Number(match[1]) * (match[2] === "s" ? 1000 : 1);
}

export function motionEasing(name: MotionEasingName): string {
  return tokenValue(`--motion-ease-${name}`).replace(/\s+/gu, " ") || EASING_FALLBACK[name];
}

export type MotionDistanceName = "xs" | "sm" | "md" | "lg";

const DISTANCE_FALLBACK: Record<MotionDistanceName, number> = { xs: 2, sm: 4, md: 8, lg: 24 };

/** Travel in px from --motion-distance-*; 0 under reduced motion. */
export function motionDistance(name: MotionDistanceName): number {
  if (prefersReducedMotion()) return 0;
  const match = /^(-?\d*\.?\d+)px$/u.exec(tokenValue(`--motion-distance-${name}`));
  return match ? Number(match[1]) : DISTANCE_FALLBACK[name];
}

/** Opacity-only keyframes for reduced motion, or null when nothing but travel remains. */
export function reducedMotionKeyframes(keyframes: Keyframe[]): Keyframe[] | null {
  const reduced = keyframes.map((frame) =>
    Object.fromEntries(Object.entries(frame).filter(([key]) => !TRANSFORM_KEYS.has(key))) as Keyframe);
  return reduced.some((frame) => "opacity" in frame) ? reduced : null;
}

export interface MotionOptions {
  duration?: MotionDurationName;
  easing?: MotionEasingName;
  delay?: number;
  fill?: FillMode;
}

export function animateMotion(
  element: Element,
  keyframes: Keyframe[],
  { duration = "base", easing = "decelerate", delay, fill }: MotionOptions = {},
): Animation | null {
  if (typeof (element as Partial<Element>).animate !== "function") return null;
  const frames = prefersReducedMotion() ? reducedMotionKeyframes(keyframes) : keyframes;
  if (!frames) return null;
  return element.animate(frames, {
    duration: motionDuration(duration),
    easing: motionEasing(easing),
    ...(delay === undefined ? {} : { delay }),
    ...(fill === undefined ? {} : { fill }),
  });
}

function cubicBezier(x1: number, y1: number, x2: number, y2: number, t: number): number {
  const sample = (a: number, b: number, s: number) => 3 * a * s * (1 - s) ** 2 + 3 * b * s ** 2 * (1 - s) + s ** 3;
  // Solve x(s) = t by bisection; 24 steps are far below a pixel of error.
  let low = 0;
  let high = 1;
  for (let step = 0; step < 24; step += 1) {
    const mid = (low + high) / 2;
    if (sample(x1, x2, mid) < t) low = mid;
    else high = mid;
  }
  return sample(y1, y2, (low + high) / 2);
}

/**
 * Eased progress (0..1) for a time fraction, from the --motion-ease-* token.
 * For JS-driven motion that is not an element animation, such as counting a
 * number; `linear()` curves fall back to linear progress.
 */
export function easeProgress(name: MotionEasingName, t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  if (clamped === 0 || clamped === 1) return clamped;
  const match = /cubic-bezier\(([^)]+)\)/u.exec(motionEasing(name));
  const points = match?.[1]!.split(",").map(Number);
  if (!points || points.length !== 4 || points.some(Number.isNaN)) return clamped;
  return cubicBezier(points[0]!, points[1]!, points[2]!, points[3]!, clamped);
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { ready: Promise<void> };
};

/**
 * Cross-fades the whole window from its current look to what `update`
 * renders — the View Transitions API: a snapshot of the old page fades into
 * the live new one over --motion-deliberate — e.g. the app appearance
 * switching light/dark on its own. `update` must change the DOM
 * synchronously (in React, wrap the state change in `flushSync`); it runs
 * later, once the old look is captured. Without support or under reduced
 * motion it runs right away, without a fade.
 */
export function crossfadeDocumentChange(update: () => void): void {
  const target = typeof document === "undefined" ? undefined : (document as ViewTransitionDocument);
  if (!target?.startViewTransition || prefersReducedMotion()) {
    update();
    return;
  }
  const transition = target.startViewTransition.call(target, update);
  void transition.ready.then(() => {
    for (const animation of target.getAnimations()) {
      const effect = animation.effect as KeyframeEffect | null;
      if (!effect?.pseudoElement?.startsWith("::view-transition")) continue;
      effect.updateTiming({ duration: motionDuration("deliberate"), easing: motionEasing("standard") });
    }
  }).catch(() => undefined);
}

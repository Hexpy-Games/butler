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
    return window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch {
    return "";
  }
}

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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

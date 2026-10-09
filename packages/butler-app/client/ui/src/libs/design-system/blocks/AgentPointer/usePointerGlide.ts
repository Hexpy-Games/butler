import { useLayoutEffect, useRef, useState } from "react";
import { animateMotion, easeProgress, motionDuration, prefersReducedMotion } from "../../lib/motion";
import { glideCurve, glideSamples, sampleAt, samePoint, throughCurve, type Cubic, type PathPoint } from "./pointerPath";

interface Glide { animation: Animation; samples: PathPoint[]; duration: number }

/**
 * Progress that leaves at slope `a` and settles at slope 0 (a cubic Hermite): an interrupted glide keeps
 * the pointer's speed instead of stopping dead, then eases into the new target. `a` is clamped to keep the
 * progress monotonic.
 */
function carryOn(a: number) {
  const slope = Math.min(3, Math.max(0, a));
  return (t: number) => slope * t + (3 - 2 * slope) * t * t + (slope - 2) * t * t * t;
}

function playhead(glide: Glide): number {
  const time = Number(glide.animation.currentTime ?? 0);
  return Number.isFinite(time) && glide.duration > 0 ? time / glide.duration : 1;
}

/**
 * Moves the pointer node along a curve whenever `at` changes: transform-only keyframes (composited) over
 * --motion-pointer-glide. A new target mid-glide continues from the drawn position along its heading at
 * its current speed, so nothing jumps; batch moves between consecutive stops follow the path through the
 * stops. Reduced motion (OS, DS scope or `reduced`) cancels any glide: the pointer jumps.
 */
export function usePointerGlide(at: PathPoint, steps: PathPoint[], batch: boolean, reduced: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef<PathPoint | null>(null);
  const glide = useRef<Glide | null>(null);
  // The curve of the latest glide, so the trail shows the path actually taken (after a retarget, too).
  const [path, setPath] = useState<Cubic | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    const previous = last.current;
    last.current = { x: at.x, y: at.y };
    if (!node || !previous || samePoint(previous, at)) return;
    const running = glide.current;
    glide.current = null;
    const live = running && running.animation.playState !== "finished" && running.animation.playState !== "idle"
      ? sampleAt(running.samples, playhead(running)) : null;
    running?.animation.cancel();
    const duration = motionDuration("pointer-glide");
    if (reduced || prefersReducedMotion() || duration <= 0) return;
    let curve: Cubic;
    let ease = (t: number) => easeProgress("standard", t);
    if (live && running) {
      curve = glideCurve(live.at, at, live.heading);
      // Speed now (px per glide) over the new curve's launch speed (3 × its first control arm).
      const arm = Math.hypot(curve[1].x - curve[0].x, curve[1].y - curve[0].y);
      const speed = Math.hypot(live.heading.x, live.heading.y) * (running.samples.length - 1) * (duration / running.duration);
      ease = carryOn(arm > 0 ? speed / (3 * arm) : 0);
    } else {
      const stops = batch ? steps : [];
      const throughStops = stops.length > 1 && samePoint(previous, stops[stops.length - 2]!) && samePoint(at, stops[stops.length - 1]!);
      curve = throughStops ? throughCurve(stops).at(-1)! : glideCurve(previous, at);
    }
    const samples = glideSamples(curve, ease);
    const animation = animateMotion(node, samples.map((point, index) => ({
      translate: `${point.x}px ${point.y}px`, offset: index / (samples.length - 1),
    })), { duration: "pointer-glide", easing: "linear" });
    if (animation) glide.current = { animation, samples, duration };
    setPath(curve);
  }, [at.x, at.y]);
  useLayoutEffect(() => () => glide.current?.animation.cancel(), []);
  return { ref, path: path && samePoint(path[3], at) ? path : null };
}

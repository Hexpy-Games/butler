import { useLayoutEffect, useMemo, useState, type RefObject } from "react";
import type { Box } from "../../heroTimeline";
import { measureInk } from "./fitInk";
import { CANVAS, type HeroLayout } from "./grid";

/**
 * What the poster paints once the finale has settled, in canvas px. The
 * static layout is not always that: a scene resizes, unrolls or moves what it
 * shows on its way to the poster. The compiled animations are held at the
 * settled beat, the poster measured, and the animations restarted.
 */
function measureSettled(root: HTMLElement, layout: HeroLayout, beat: number, beats: number): Box | null {
  const world = root.querySelector<HTMLElement>('[data-t="world"]');
  const poster = root.querySelector<HTMLElement>('[data-t="poster"]');
  const animations = root.getAnimations({ subtree: true });
  if (!world || !poster || animations.length === 0) return null;
  // Seek and read within one task (the timeline does not advance meanwhile), then seek back: no play or pause
  // call, so the stage's own animation-play-state (offscreen, hidden) keeps control.
  const before = animations.map((animation) => animation.currentTime);
  for (const animation of animations) {
    const duration = Number(animation.effect?.getTiming().duration ?? 0);
    animation.currentTime = (duration * beat) / beats;
  }
  // The world's own box maps the canvas onto its rect at every pose (flat, uniform zoom).
  const origin = world.getBoundingClientRect();
  const ink = origin.width > 0 ? measureInk(poster, origin, origin.width / CANVAS[layout].w) : null;
  animations.forEach((animation, k) => {
    animation.currentTime = before[k] ?? 0;
  });
  return ink;
}

/** Frames the second pass waits for the poster to stop resizing itself. */
const SETTLE_FRAMES = 6;

/**
 * Compiles a hero's timeline in two passes on the wide canvas: the static
 * layout's, then (once its animations are in the DOM) one whose finale frames
 * the poster as it really ends, measured with the animations held at the
 * settled beat. Returns the final compile.
 */
export function useSettledCompile<G extends { ink?: Box }, C extends { beats: number; marks: number[] }>(root: RefObject<HTMLElement | null>, base: G | null, layout: HeroLayout, compile: (geometry: G) => C): C | null {
  const [settled, setSettled] = useState<{ base: G; ink: Box } | null>(null);
  const geometry = useMemo(() => (base && settled?.base === base ? { ...base, ink: settled.ink } : base), [base, settled]);
  const compiled = useMemo(() => (geometry ? compile(geometry) : null), [geometry, compile]);
  useLayoutEffect(() => {
    const node = root.current;
    if (!base || !compiled || !node || settled?.base === base) return undefined;
    // A few frames later: the compile's animations have started, and what sizes itself to its tile
    // (a device still fitting its slot) has followed the tile's own fit.
    let frame = 0;
    let left = SETTLE_FRAMES;
    const tick = () => {
      left -= 1;
      if (left > 0) {
        frame = requestAnimationFrame(tick);
        return;
      }
      const ink = measureSettled(node, layout, compiled.marks.at(-1) ?? compiled.beats / 2, compiled.beats);
      if (ink) setSettled({ base, ink });
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [base, compiled, layout, root, settled]);
  return compiled;
}

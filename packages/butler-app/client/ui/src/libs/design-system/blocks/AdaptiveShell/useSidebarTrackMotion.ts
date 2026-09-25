import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { animateMotion, prefersReducedMotion } from "../../lib/motion";

/**
 * Docked sidebar open/close as compositor motion (DS Motion Contract).
 *
 * The grid track is never interpolated: that re-laid out the whole workspace
 * every frame, and with real conversations the frames dropped until the
 * collapse read as a jump. Instead the track changes in one step while the
 * sidebar slides with a CSS transform and the workspace is FLIP-translated
 * alongside it:
 * - closing commits the 0px track at once and slides the workspace in from
 *   the old sidebar width;
 * - opening keeps the 0px track, slides the workspace aside with the
 *   sidebar, and commits the track when the motion finishes, so the
 *   workspace reflows once, already in place.
 * Reduced motion, drawer layout and live resizing commit immediately; the
 * sidebar then only fades.
 */
export function useSidebarTrackMotion({
  rootRef,
  leftOpen,
  animate,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  leftOpen: boolean;
  animate: boolean;
}): { leftTrack: boolean; switching: boolean } {
  const [openedTrack, setOpenedTrack] = useState(leftOpen);
  const [switching, setSwitching] = useState(false);
  const previousOpen = useRef(leftOpen);
  const motion = useRef<Animation | null>(null);
  // Closing leads: the track is 0px in the same render that closes.
  const leftTrack = leftOpen && openedTrack;
  // Mark the render that switches the track so the grid does not interpolate it.
  const [renderedTrack, setRenderedTrack] = useState(leftTrack);
  if (renderedTrack !== leftTrack) {
    setRenderedTrack(leftTrack);
    setSwitching(true);
  }

  useLayoutEffect(() => {
    const wasOpen = previousOpen.current;
    previousOpen.current = leftOpen;
    if (wasOpen === leftOpen) return;
    const root = rootRef.current;
    const workspace = root?.querySelector<HTMLElement>("[data-slot=adaptive-shell-workspace]");
    const sidebar = root?.querySelector<HTMLElement>("[data-slot=adaptive-shell-sidebar]");
    // Where the workspace is right now, including an interrupted motion.
    const currentOffset = workspace ? translateXOf(getComputedStyle(workspace).transform) : 0;
    motion.current?.cancel();
    motion.current = null;
    const width = sidebar?.getBoundingClientRect().width ?? 0;
    const canAnimate = animate && !prefersReducedMotion() && workspace && width > 0;
    if (!leftOpen) {
      setOpenedTrack(false);
      if (canAnimate) {
        // The track just collapsed: start where the workspace was drawn.
        const from = wasOpen && currentOffset === 0 ? width : currentOffset;
        motion.current = animateMotion(workspace, [slide(from), slide(0)], { duration: "slow", easing: "emphasized" });
      }
      return;
    }
    if (!canAnimate) {
      setOpenedTrack(true);
      return;
    }
    const animation = animateMotion(workspace, [slide(currentOffset), slide(width)], {
      duration: "slow",
      easing: "emphasized",
      fill: "forwards",
    });
    motion.current = animation;
    if (!animation) {
      setOpenedTrack(true);
      return;
    }
    animation.finished.then(() => {
      if (motion.current === animation) setOpenedTrack(true);
    }, () => undefined);
  }, [leftOpen, animate, rootRef]);

  // The committed track now places the workspace where the motion left it:
  // drop the held transform before paint.
  useLayoutEffect(() => {
    if (!leftTrack || !motion.current) return;
    motion.current.cancel();
    motion.current = null;
  }, [leftTrack]);

  // Track switches never interpolate; re-enable grid motion (right panel)
  // one frame after the switch has been applied.
  useLayoutEffect(() => {
    if (!switching) return;
    const frame = requestAnimationFrame(() => setSwitching(false));
    return () => cancelAnimationFrame(frame);
  }, [switching]);

  return { leftTrack, switching };
}

/**
 * Workspace shifted by `offset`, with the same amount clipped off its right
 * edge so it never slides under a transparent inspector.
 */
function slide(offset: number): Keyframe {
  return { transform: `translateX(${offset}px)`, clipPath: `inset(0px ${offset}px 0px 0px)` };
}

/** X translation of a computed `matrix(...)` transform; 0 for none. */
function translateXOf(transform: string): number {
  const values = /^matrix\(([^)]+)\)$/u.exec(transform)?.[1]?.split(",").map(Number);
  return values && values.length === 6 && Number.isFinite(values[4]) ? values[4]! : 0;
}

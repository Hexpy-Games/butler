import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { animateMotion, prefersReducedMotion } from "../../lib/motion";

/**
 * Docked right inspector open/close. The inspector slides with a CSS
 * transform (compositor) and the right grid track follows it: the track is
 * committed at once and its width (`--adaptive-right-track`, a registered
 * non-inherited length, so only the shell root restyles) is animated from
 * where it was to the committed width on the inspector's own tokens (slow /
 * emphasized). The workspace narrows on open and widens on close in lockstep
 * with the panel instead of snapping at one end of the slide; the price is
 * one workspace layout per frame while it moves. (The sidebar keeps its FLIP
 * model, useSidebarTrackMotion.)
 * Shell geometry keyed to the committed track, such as the cards title row
 * that reaches over the inspector's column to the window edge, moves from its
 * old to its new value with the same timing, so it stays in place.
 * Reduced motion, drawer layout and live resizing commit immediately.
 */
export function useInspectorTrackMotion({
  rootRef,
  rightOpen,
  animate,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  rightOpen: boolean;
  animate: boolean;
}): { rightTrack: boolean; switching: boolean } {
  const [rightTrack, setRightTrack] = useState(rightOpen);
  const [switching, setSwitching] = useState(false);
  const motion = useRef<Animation[]>([]);
  const from = useRef<TrackGeometry | null>(null);
  const [renderedTrack, setRenderedTrack] = useState(rightTrack);
  if (renderedTrack !== rightTrack) {
    setRenderedTrack(rightTrack);
    setSwitching(true);
  }

  // The open state changed: note where the geometry is now (mid-motion
  // included), then commit the track in a second render before paint.
  useLayoutEffect(() => {
    if (rightOpen === rightTrack) return;
    const root = rootRef.current;
    from.current = root && animate && !prefersReducedMotion() ? readGeometry(root) : null;
    cancel(motion.current);
    motion.current = [];
    setRightTrack(rightOpen);
  }, [rightOpen, rightTrack, animate, rootRef]);

  // The track is committed: move the geometry from where it was to there.
  useLayoutEffect(() => {
    const start = from.current;
    from.current = null;
    const root = rootRef.current;
    if (!start || !root) return;
    const end = readGeometry(root);
    const title = titleOf(root);
    motion.current = [
      animateBetween(root, "--adaptive-right-track", start.track, end.track),
      title ? animateBetween(title, "right", start.title, end.title) : null,
    ].filter((animation): animation is Animation => animation !== null);
  }, [rightTrack, rootRef]);

  // A resize drag takes the track over: never fight it with a stale motion.
  useLayoutEffect(() => {
    if (animate) return;
    cancel(motion.current);
    motion.current = [];
  }, [animate]);

  useLayoutEffect(() => {
    if (!switching) return;
    const frameId = requestAnimationFrame(() => setSwitching(false));
    return () => cancelAnimationFrame(frameId);
  }, [switching]);

  return { rightTrack, switching };
}

type TrackGeometry = { track: string; title: string | null };

function titleOf(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>("[data-slot=adaptive-shell-title]");
}

/** Computed values, so a running motion reads at its current frame. */
function readGeometry(root: HTMLElement): TrackGeometry {
  const title = titleOf(root);
  return {
    track: getComputedStyle(root).getPropertyValue("--adaptive-right-track").trim(),
    title: title ? getComputedStyle(title).right : null,
  };
}

function animateBetween(element: HTMLElement, property: string, start: string | null, end: string | null) {
  if (!start || !end || start === end) return null;
  return animateMotion(element, [{ [property]: start }, { [property]: end }], {
    duration: "slow",
    easing: "emphasized",
  });
}

function cancel(animations: Animation[]) {
  for (const animation of animations) animation.cancel();
}

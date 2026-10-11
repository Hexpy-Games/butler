import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { animateMotion, prefersReducedMotion } from "../../lib/motion";
import { inspectorSlideClip, type ShellFrame } from "./shellFrame";

/**
 * Docked right inspector open/close as compositor motion, like the sidebar
 * (useSidebarTrackMotion). The right grid track never interpolates:
 * - opening keeps the 0px track while the inspector slides in (CSS
 *   transform) over the workspace, whose right edge is clipped in step so
 *   nothing shows under a translucent panel, and commits the track when the
 *   slide ends: the workspace reflows once, under the panel;
 * - closing commits the 0px track at once and the inspector slides out.
 * Reduced motion, drawer layout and live resizing commit immediately.
 * In the cards frame the clip spares the title row (it spans to the window
 * edge, so its icons never move) and cuts at the inspector card's gap.
 */
export function useInspectorTrackMotion({
  rootRef,
  rightOpen,
  animate,
  frame = "flat",
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  rightOpen: boolean;
  animate: boolean;
  frame?: ShellFrame;
}): { rightTrack: boolean; switching: boolean } {
  const [openedTrack, setOpenedTrack] = useState(rightOpen);
  const [switching, setSwitching] = useState(false);
  const previousOpen = useRef(rightOpen);
  const motion = useRef<Animation | null>(null);
  const rightTrack = rightOpen && openedTrack;
  const [renderedTrack, setRenderedTrack] = useState(rightTrack);
  if (renderedTrack !== rightTrack) {
    setRenderedTrack(rightTrack);
    setSwitching(true);
  }

  useLayoutEffect(() => {
    const wasOpen = previousOpen.current;
    previousOpen.current = rightOpen;
    if (wasOpen === rightOpen) return;
    motion.current?.cancel();
    motion.current = null;
    if (!rightOpen) {
      setOpenedTrack(false);
      return;
    }
    const root = rootRef.current;
    const workspace = root?.querySelector<HTMLElement>("[data-slot=adaptive-shell-workspace]");
    const inspector = root?.querySelector<HTMLElement>("[data-slot=adaptive-shell-inspector]");
    const width = inspector?.getBoundingClientRect().width ?? 0;
    if (!animate || prefersReducedMotion() || !workspace || width <= 0) {
      setOpenedTrack(true);
      return;
    }
    const cut = frame === "cards" ? width + cssPx(root, "--shell-card-inset") + cssPx(root, "--shell-card-gap") : width;
    const title = root?.querySelector<HTMLElement>("[data-slot=adaptive-shell-title]")?.offsetHeight ?? 0;
    const animation = animateMotion(workspace, [
      { clipPath: inspectorSlideClip(frame, 0, title) },
      { clipPath: inspectorSlideClip(frame, cut, title) },
    ], { duration: "slow", easing: "emphasized", fill: "forwards" });
    motion.current = animation;
    if (!animation) {
      setOpenedTrack(true);
      return;
    }
    animation.finished.then(() => {
      if (motion.current === animation) setOpenedTrack(true);
    }, () => undefined);
  }, [rightOpen, animate, rootRef, frame]);

  // The committed track now narrows the workspace itself: drop the held clip.
  useLayoutEffect(() => {
    if (!rightTrack || !motion.current) return;
    motion.current.cancel();
    motion.current = null;
  }, [rightTrack]);

  useLayoutEffect(() => {
    if (!switching) return;
    const frameId = requestAnimationFrame(() => setSwitching(false));
    return () => cancelAnimationFrame(frameId);
  }, [switching]);

  return { rightTrack, switching };
}

/** A length custom property resolved on the shell root, in px (0 when unset). */
function cssPx(element: HTMLElement | null | undefined, name: string): number {
  return element ? Number.parseFloat(getComputedStyle(element).getPropertyValue(name)) || 0 : 0;
}

import { useEffect, useState, type RefObject } from "react";
import { prefersReducedMotion, subscribeReducedMotion } from "../../lib/motion";

/**
 * playing: the CSS loops run. paused: offscreen or the document is hidden, so
 * every loop holds its frame (animation-play-state). still: reduced motion,
 * the poster frame with no animation at all.
 */
export type HeroPlayback = "playing" | "paused" | "still";

/**
 * One IntersectionObserver and one visibilitychange listener serve every hero
 * on the page. The heroes are CSS animations (no frame loop of their own), so
 * pausing them offscreen is all the JS they need.
 */
const watchers = new Map<Element, (inView: boolean) => void>();
const visibilityListeners = new Set<() => void>();
let observer: IntersectionObserver | null = null;

function onVisibilityChange() {
  for (const listener of visibilityListeners) listener();
}

function watch(element: Element, onView: (inView: boolean) => void, onVisibility: () => void): () => void {
  if (typeof IntersectionObserver === "function") {
    observer ??= new IntersectionObserver((entries) => {
      for (const entry of entries) watchers.get(entry.target)?.(entry.isIntersecting);
    });
    watchers.set(element, onView);
    observer.observe(element);
  }
  if (visibilityListeners.size === 0) document.addEventListener("visibilitychange", onVisibilityChange);
  visibilityListeners.add(onVisibility);
  return () => {
    watchers.delete(element);
    observer?.unobserve(element);
    if (observer && watchers.size === 0) {
      observer.disconnect();
      observer = null;
    }
    visibilityListeners.delete(onVisibility);
    if (visibilityListeners.size === 0) document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}

/** Playback of one hero: still under reduced motion, paused while it cannot be seen. */
export function useHeroPlayback(ref: RefObject<Element | null>, forceStill = false): HeroPlayback {
  const [reduced, setReduced] = useState(() => forceStill || prefersReducedMotion());
  const [inView, setInView] = useState(true);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    setReduced(forceStill || prefersReducedMotion());
    return forceStill ? undefined : subscribeReducedMotion(setReduced);
  }, [forceStill]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const onVisibility = () => setHidden(document.visibilityState === "hidden");
    onVisibility();
    return watch(element, setInView, onVisibility);
  }, [ref]);
  if (reduced) return "still";
  return inView && !hidden ? "playing" : "paused";
}

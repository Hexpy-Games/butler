import { useLayoutEffect, useRef, type WheelEvent } from "react";
import { useComposedRefs } from "../../lib/composeRefs";
import { prefersReducedMotion } from "../../lib/motion";
import { useScrollEdges } from "../../lib/useScrollEdges";

/** Scrolls `target` into the scroller's visible span, clear of the edge fade. */
export function revealInScroller(scroller: HTMLElement, target: HTMLElement) {
  const box = scroller.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  const clearance = Math.min(box.width / 4, parseFloat(getComputedStyle(scroller).getPropertyValue("--scroll-fade-size")) || 0);
  const behavior = prefersReducedMotion() ? "auto" : "smooth";
  if (rect.left < box.left + clearance) scroller.scrollBy({ left: rect.left - box.left - clearance, behavior });
  else if (rect.right > box.right - clearance) scroller.scrollBy({ left: rect.right - box.right + clearance, behavior });
}

/**
 * The strip's horizontal scroller: edge fades while tabs overflow, a vertical wheel scrolls
 * sideways, and the active tab is kept in view.
 */
export function useTabStripScroller(activeNode: () => HTMLElement | null, activeKey: string | null) {
  const node = useRef<HTMLDivElement | null>(null);
  const edges = useScrollEdges("x");
  const ref = useComposedRefs<HTMLDivElement>(node, edges);

  useLayoutEffect(() => {
    const scroller = node.current;
    const target = activeNode();
    if (scroller && target && scroller.scrollWidth > scroller.clientWidth) revealInScroller(scroller, target);
  }, [activeKey, activeNode]);

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    const scroller = event.currentTarget;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || scroller.scrollWidth <= scroller.clientWidth) return;
    scroller.scrollLeft += event.deltaY;
  };

  return { ref, onWheel };
}

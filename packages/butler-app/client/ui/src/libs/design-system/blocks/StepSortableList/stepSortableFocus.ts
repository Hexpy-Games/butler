import type { RefObject } from "react";
import { stepDragId } from "./stepSortableContext";

/**
 * After a keyboard drop, focus follows the moved items to their new place: the item's grip,
 * else the grip (or toggle) of the step that now holds it.
 */
export function focusAfterDrop(root: HTMLElement | null, request: RefObject<string | null>) {
  const id = request.current;
  if (!id || !root) return;
  const grips = [...root.querySelectorAll<HTMLElement>("[data-step-grip]")];
  const step = [...root.querySelectorAll<HTMLElement>("[data-step-items]")]
    .find((node) => node.dataset.stepItems!.split(" ").includes(id));
  const first = step?.dataset.stepItems!.split(" ")[0];
  const next = grips.find((node) => node.dataset.stepGrip === `item:${id}`)
    ?? grips.find((node) => first && node.dataset.stepGrip === stepDragId(first))
    ?? step?.querySelector<HTMLElement>("[data-stack-deck-toggle]");
  if (!next) return;
  (request as { current: string | null }).current = null;
  next.focus();
}

/** The nearest ancestor that scrolls vertically: the pane's own content scroller. */
function scrollerOf(node: HTMLElement | null): Element | null {
  for (let current = node?.parentElement ?? null; current; current = current.parentElement) {
    const overflow = getComputedStyle(current).overflowY;
    if (overflow === "auto" || overflow === "scroll") return current;
  }
  return null;
}

/** Drags auto-scroll only the list's own pane scroller, near its top and bottom 12%. */
export function listAutoScroll(root: RefObject<HTMLElement | null>) {
  return {
    threshold: { x: 0, y: 0.12 },
    canScroll: (element: Element) => element === scrollerOf(root.current),
  };
}

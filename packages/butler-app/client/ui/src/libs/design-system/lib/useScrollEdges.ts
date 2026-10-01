import { useCallback } from "react";

export type ScrollEdgeAxis = "x" | "y";

export interface ScrollEdges {
  overflowing: boolean;
  atStart: boolean;
  atEnd: boolean;
}

const EDGE_TOLERANCE_PX = 1;

export function readScrollEdges(
  element: HTMLElement,
  axis: ScrollEdgeAxis,
): ScrollEdges {
  const position = Math.abs(axis === "x" ? element.scrollLeft : element.scrollTop);
  const size = axis === "x" ? element.clientWidth : element.clientHeight;
  const total = axis === "x" ? element.scrollWidth : element.scrollHeight;
  const overflowing = total - size > EDGE_TOLERANCE_PX;
  return {
    overflowing,
    atStart: !overflowing || position <= EDGE_TOLERANCE_PX,
    atEnd: !overflowing || position + size >= total - EDGE_TOLERANCE_PX,
  };
}

function writeFlag(element: HTMLElement, key: keyof ScrollEdges, value: boolean) {
  const next = String(value);
  if (element.dataset[key] !== next) element.dataset[key] = next;
}

function writeScrollEdges(element: HTMLElement, edges: ScrollEdges) {
  writeFlag(element, "overflowing", edges.overflowing);
  writeFlag(element, "atStart", edges.atStart);
  writeFlag(element, "atEnd", edges.atEnd);
}

/**
 * Tracks scroll edges for one scroller and mirrors them to
 * data-overflowing / data-at-start / data-at-end. Scroll and resize work is
 * batched into one animation frame.
 */
export function observeScrollEdges(
  element: HTMLElement,
  axis: ScrollEdgeAxis,
): () => void {
  let frame = 0;
  const observedChildren = new Set<Element>();
  const update = () => {
    frame = 0;
    writeScrollEdges(element, readScrollEdges(element, axis));
  };
  const schedule = () => {
    if (frame === 0) frame = requestAnimationFrame(update);
  };
  const resizeObserver =
    typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
  const observeChildren = () => {
    const children = new Set(element.children);
    for (const child of observedChildren) {
      if (!children.has(child)) {
        resizeObserver?.unobserve(child);
        observedChildren.delete(child);
      }
    }
    for (const child of children) {
      if (!observedChildren.has(child)) {
        resizeObserver?.observe(child);
        observedChildren.add(child);
      }
    }
  };
  const mutationObserver =
    typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(() => {
        observeChildren();
        schedule();
      });

  update();
  element.addEventListener("scroll", schedule, { passive: true });
  element.addEventListener("transitionend", schedule);
  resizeObserver?.observe(element);
  observeChildren();
  mutationObserver?.observe(element, { childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ["style", "class", "hidden", "dir"] });

  return () => {
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
    element.removeEventListener("scroll", schedule);
    element.removeEventListener("transitionend", schedule);
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
  };
}

/**
 * Callback ref that opts an element into the shared scroll-fade mask
 * (see scroll-fade.css). Pass `enabled: false` to keep the scroller unmasked.
 */
export function useScrollEdges(axis: ScrollEdgeAxis, enabled = true) {
  return useCallback(
    (element: HTMLElement | null) => {
      if (!element || !enabled) return undefined;
      element.dataset.scrollFade = axis;
      const stop = observeScrollEdges(element, axis);
      return () => {
        stop();
        delete element.dataset.scrollFade;
      };
    },
    [axis, enabled],
  );
}

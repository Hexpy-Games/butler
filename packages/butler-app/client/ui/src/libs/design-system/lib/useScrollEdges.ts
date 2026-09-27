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
  let observedChild: Element | null = null;
  const update = () => {
    frame = 0;
    writeScrollEdges(element, readScrollEdges(element, axis));
  };
  const schedule = () => {
    if (frame === 0) frame = requestAnimationFrame(update);
  };
  const resizeObserver =
    typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
  const observeFirstChild = () => {
    const child = element.firstElementChild;
    if (child === observedChild) return;
    if (observedChild) resizeObserver?.unobserve?.(observedChild);
    observedChild = child;
    if (child) resizeObserver?.observe(child);
  };
  const mutationObserver =
    typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(() => {
        observeFirstChild();
        schedule();
      });

  update();
  element.addEventListener("scroll", schedule, { passive: true });
  resizeObserver?.observe(element);
  observeFirstChild();
  mutationObserver?.observe(element, { childList: true });

  return () => {
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
    element.removeEventListener("scroll", schedule);
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

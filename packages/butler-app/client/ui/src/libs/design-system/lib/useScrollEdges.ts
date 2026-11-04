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
 * batched into one animation frame; `onUpdate` runs after each such update.
 */
export function observeScrollEdges(
  element: HTMLElement,
  axis: ScrollEdgeAxis,
  onUpdate?: () => void,
): () => void {
  let frame = 0;
  const observedChildren = new Set<Element>();
  const update = () => {
    frame = 0;
    writeScrollEdges(element, readScrollEdges(element, axis));
    onUpdate?.();
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
  element.addEventListener("input", schedule);
  element.addEventListener("transitionend", schedule);
  resizeObserver?.observe(element);
  observeChildren();
  mutationObserver?.observe(element, { childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ["style", "class", "hidden", "dir"] });

  return () => {
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
    element.removeEventListener("scroll", schedule);
    element.removeEventListener("input", schedule);
    element.removeEventListener("transitionend", schedule);
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
  };
}

function cssLength(style: CSSStyleDeclaration, name: string): number {
  return Number.parseFloat(style.getPropertyValue(name)) || 0;
}

/** The target's ring span on `axis` and the band of the scroller its fades and ring room leave clear. */
function ringBand(element: HTMLElement, axis: ScrollEdgeAxis, target: Element) {
  const scrollerStyle = getComputedStyle(element);
  const targetStyle = getComputedStyle(target);
  const outline = targetStyle.outlineStyle === "none" ? 0
    : cssLength(targetStyle, "outline-width") + cssLength(targetStyle, "outline-offset");
  const ring = Math.max(cssLength(scrollerStyle, "--focus-ring-room"), outline);
  const fade = cssLength(scrollerStyle, "--scroll-fade-size");
  const box = element.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  const [start, size, low, high] = axis === "x"
    ? [box.left + element.clientLeft, element.clientWidth, rect.left - ring, rect.right + ring]
    : [box.top + element.clientTop, element.clientHeight, rect.top - ring, rect.bottom + ring];
  return { low, high, first: start + fade, last: start + size - fade };
}

/**
 * True when `target`'s ring does not fit the band the scroller shows clear of
 * its fades and ring room, so no scroll position shows all of it.
 */
export function focusOutgrowsScroller(element: HTMLElement, axis: ScrollEdgeAxis, target: Element): boolean {
  const { low, high, first, last } = ringBand(element, axis, target);
  return high - low > last - first + 0.5;
}

const RING_HOST = "data-focus-ring-host";

/**
 * Hands the ring of a keyboard-focused control the scroller can never show
 * whole to the scroller itself (data-focus-ring-host, drawn by
 * scroll-fade.css). Only the innermost such scroller takes it. Measured when
 * focus arrives, before it paints, and again whenever the scroller's edges
 * update (a resize) while that focus stays inside.
 */
function trackRingHost(element: HTMLElement, axis: ScrollEdgeAxis) {
  let focused: Element | null = null;
  const measure = () => {
    const nearer = focused?.parentElement?.closest(`[${RING_HOST}]`);
    const innermost = !nearer || nearer === element || !element.contains(nearer);
    element.toggleAttribute(RING_HOST, focused !== null && innermost && focusOutgrowsScroller(element, axis, focused));
  };
  return {
    focus(target: Element | null) { focused = target; measure(); },
    refresh() { if (focused) measure(); },
    stop() { focused = null; element.removeAttribute(RING_HOST); },
  };
}

/**
 * Scrolls `target` (keyboard focus) so its focus ring sits clear of the
 * scroller's edge fades. Native focus scrolling stops at the scrollport edge
 * and leaves a partly visible control where it is, under the fade.
 */
export function revealFocusInFades(
  element: HTMLElement,
  axis: ScrollEdgeAxis,
  target: Element,
) {
  const { low, high, first, last } = ringBand(element, axis, target);
  const delta = low < first || high - low > last - first ? low - first : high > last ? high - last : 0;
  if (Math.abs(delta) < 0.5) return;
  if (axis === "x") element.scrollLeft += delta;
  else element.scrollTop += delta;
  // A focus scroll can clamp at an edge; refresh its mask before that frame paints.
  writeScrollEdges(element, readScrollEdges(element, axis));
}

/**
 * Callback ref that opts an element into the shared scroll-fade mask
 * (see scroll-fade.css) and keeps keyboard focus clear of its fades; a
 * focused control too large for the scroller gets its ring drawn by the
 * scroller (see trackRingHost). Pass `enabled: false` to keep the scroller
 * unmasked.
 */
export function useScrollEdges(axis: ScrollEdgeAxis, enabled = true) {
  return useCallback(
    (element: HTMLElement | null) => {
      if (!element || !enabled) return undefined;
      element.dataset.scrollFade = axis;
      const host = trackRingHost(element, axis);
      const stop = observeScrollEdges(element, axis, host.refresh);
      let frame = 0;
      // Only keyboard focus: a pointer press must not move its row (#792).
      const reveal = (event: FocusEvent) => {
        const target = event.target;
        const keyboard = target instanceof Element && target !== element && target.matches(":focus-visible");
        host.focus(keyboard ? target : null);
        if (!keyboard) return;
        cancelAnimationFrame(frame);
        // After the browser's own focus scroll.
        frame = requestAnimationFrame(() => revealFocusInFades(element, axis, target));
      };
      const release = (event: FocusEvent) => {
        if (!(event.relatedTarget instanceof Node && element.contains(event.relatedTarget))) host.focus(null);
      };
      element.addEventListener("focusin", reveal);
      element.addEventListener("focusout", release);
      return () => {
        cancelAnimationFrame(frame);
        element.removeEventListener("focusin", reveal);
        element.removeEventListener("focusout", release);
        host.stop();
        stop();
        delete element.dataset.scrollFade;
      };
    },
    [axis, enabled],
  );
}

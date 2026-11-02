import { useCallback } from "react";

export type ScrollEdgeAxis = "x" | "y";
/** A scroller's fade axes: one, or `both` for content that overflows in two directions (a code frame). */
export type ScrollFadeAxis = ScrollEdgeAxis | "both";

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

function writeFlag(element: HTMLElement, key: string, value: boolean) {
  const next = String(value);
  if (element.dataset[key] !== next) element.dataset[key] = next;
}

function writeScrollEdges(element: HTMLElement, edges: ScrollEdges, suffix = "") {
  writeFlag(element, `overflowing${suffix}`, edges.overflowing);
  writeFlag(element, `atStart${suffix}`, edges.atStart);
  writeFlag(element, `atEnd${suffix}`, edges.atEnd);
}

/**
 * One axis mirrors data-overflowing / data-at-start / data-at-end; `both`
 * mirrors each axis on its own (data-overflowing-x, data-at-end-y, ...).
 */
function writeAxes(element: HTMLElement, axis: ScrollFadeAxis) {
  if (axis !== "both") return writeScrollEdges(element, readScrollEdges(element, axis));
  writeScrollEdges(element, readScrollEdges(element, "x"), "X");
  writeScrollEdges(element, readScrollEdges(element, "y"), "Y");
}

/**
 * Tracks scroll edges for one scroller and mirrors them to its data
 * attributes (see writeAxes). Scroll and resize work is batched into one
 * animation frame.
 */
export function observeScrollEdges(
  element: HTMLElement,
  axis: ScrollFadeAxis,
): () => void {
  let frame = 0;
  const observedChildren = new Set<Element>();
  const update = () => {
    frame = 0;
    writeAxes(element, axis);
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

/**
 * Scrolls `target` (keyboard focus) so its focus ring sits clear of the
 * scroller's edge fades. Native focus scrolling stops at the scrollport edge
 * and leaves a partly visible control where it is, under the fade.
 */
export function revealFocusInFades(
  element: HTMLElement,
  axis: ScrollFadeAxis,
  target: Element,
) {
  const moved = (axis === "both" ? (["x", "y"] as const) : [axis])
    .map((each) => revealOnAxis(element, each, target)).some(Boolean);
  // A focus scroll can clamp at an edge; refresh its mask before that frame paints.
  if (moved) writeAxes(element, axis);
}

function revealOnAxis(element: HTMLElement, axis: ScrollEdgeAxis, target: Element): boolean {
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
  const first = start + fade;
  const last = start + size - fade;
  const delta = low < first || high - low > last - first ? low - first : high > last ? high - last : 0;
  if (Math.abs(delta) < 0.5) return false;
  if (axis === "x") element.scrollLeft += delta;
  else element.scrollTop += delta;
  return true;
}

/**
 * Callback ref that opts an element into the shared scroll-fade mask
 * (see scroll-fade.css) and keeps keyboard focus clear of its fades. Pass
 * `enabled: false` to keep the scroller unmasked. `both` fades each edge of
 * either axis that has hidden content (data-scroll-fade="both").
 */
export function useScrollEdges(axis: ScrollFadeAxis, enabled = true) {
  return useCallback(
    (element: HTMLElement | null) => {
      if (!element || !enabled) return undefined;
      element.dataset.scrollFade = axis;
      const stop = observeScrollEdges(element, axis);
      let frame = 0;
      // Only keyboard focus: a pointer press must not move its row (#792).
      const reveal = (event: FocusEvent) => {
        const target = event.target;
        if (!(target instanceof Element) || target === element || !target.matches(":focus-visible")) return;
        cancelAnimationFrame(frame);
        // After the browser's own focus scroll.
        frame = requestAnimationFrame(() => revealFocusInFades(element, axis, target));
      };
      element.addEventListener("focusin", reveal);
      return () => {
        cancelAnimationFrame(frame);
        element.removeEventListener("focusin", reveal);
        stop();
        delete element.dataset.scrollFade;
      };
    },
    [axis, enabled],
  );
}

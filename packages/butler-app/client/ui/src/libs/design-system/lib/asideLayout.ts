import { useLayoutEffect, useState } from "react";

/** Where a block's aside sits: flat in the block's own margin, or on glass over its content. */
export type AsideLayout = "docked" | "floating";

/** Room a floating aside needs past the dock line before it docks again, so a width on the line never flaps. */
export const ASIDE_DOCK_HYSTERESIS = 32;

/** The next layout for `width`: docks from `min`, but a floating aside docks again only from `min` + hysteresis. */
export function nextAsideLayout(current: AsideLayout | null, width: number, min: number): AsideLayout {
  if (current === "docked") return width >= min ? "docked" : "floating";
  if (current === "floating") return width >= min + ASIDE_DOCK_HYSTERESIS ? "docked" : "floating";
  return width >= min ? "docked" : "floating";
}

/**
 * The aside's layout from `element`'s layout width (CSS px, as its container queries see it; a scaled
 * ancestor does not change it): docked from `min`, floating below. Change-driven: one ResizeObserver on
 * the element and a state update only when the layout flips. `null` while disabled or not yet measured,
 * so nothing renders in the wrong place first.
 */
export function useAsideLayout(element: HTMLElement | null, enabled: boolean, min: number): AsideLayout | null {
  const [layout, setLayout] = useState<AsideLayout | null>(null);
  // A closed aside forgets its layout: reopened after a resize, it must not mount where it last was.
  if (!enabled && layout !== null) setLayout(null);
  useLayoutEffect(() => {
    if (!enabled || !element) return undefined;
    const update = () => setLayout((current) => nextAsideLayout(current, element.offsetWidth, min));
    update();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, enabled, min]);
  return enabled ? layout : null;
}

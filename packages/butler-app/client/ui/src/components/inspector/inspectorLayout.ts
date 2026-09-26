import type { UnsafeStyle } from "@/butler-ds";

/**
 * Context legend scroller geometry. The frame bleeds into the inspector gutter
 * through ScrollArea `bleed="inline-end"`; only the minimum height stays here
 * as an allowlisted UNSAFE_style.
 */
export const contextLegendGeometry: UnsafeStyle = {
  minHeight: "96px",
};

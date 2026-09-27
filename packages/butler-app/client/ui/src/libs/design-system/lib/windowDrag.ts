/**
 * Electron window drag regions. `drag` makes the element a window drag
 * region whose interactive descendants stay clickable (`.drag-region` in
 * tokens.css); `no-drag` excludes the element (and its subtree) from an
 * enclosing drag region.
 */
export type WindowDrag = "drag" | "no-drag";

export interface WindowDragProps {
  /** Window drag region behavior on desktop (`drag` titlebars, `no-drag` controls inside them). */
  windowDrag?: WindowDrag;
}

/** The global class that implements a `windowDrag` value. */
export function windowDragClassName(windowDrag: WindowDrag | undefined): string | undefined {
  if (windowDrag === "drag") return "drag-region";
  if (windowDrag === "no-drag") return "no-drag";
  return undefined;
}

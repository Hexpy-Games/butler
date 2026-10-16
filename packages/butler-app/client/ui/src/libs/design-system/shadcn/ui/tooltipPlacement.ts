/** Which side of the trigger the tooltip opens on. */
export type TooltipSide = "top" | "right" | "bottom" | "left";
/** Where the tooltip lines up along that side: the trigger's start edge, its center, or its end edge. */
export type TooltipAlign = "start" | "center" | "end";

export interface TooltipRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

export interface TooltipBounds {
  width: number;
  height: number;
  /** Gap kept from the viewport's left, right and bottom edges. */
  padding: number;
  /** Lowest top a tooltip may take (the titlebar safe area). */
  safeTop: number;
  /** Gap between the trigger and the tooltip. */
  offset: number;
}

export interface TooltipPlacement {
  left: number;
  top: number;
  /** The side actually used after flipping. */
  side: TooltipSide;
}

const OPPOSITE: Record<TooltipSide, TooltipSide> = { top: "bottom", bottom: "top", left: "right", right: "left" };
const CROSS: Record<TooltipSide, [TooltipSide, TooltipSide]> = {
  top: ["right", "left"],
  bottom: ["right", "left"],
  left: ["top", "bottom"],
  right: ["top", "bottom"],
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, Math.max(min, max)));
}

function isVertical(side: TooltipSide): boolean {
  return side === "top" || side === "bottom";
}

/** Room between the trigger and the viewport edge on `side`, minus the gap. */
function room(side: TooltipSide, trigger: TooltipRect, bounds: TooltipBounds): number {
  if (side === "top") return trigger.top - bounds.offset - bounds.safeTop;
  if (side === "bottom") return bounds.height - bounds.padding - trigger.bottom - bounds.offset;
  if (side === "left") return trigger.left - bounds.offset - bounds.padding;
  return bounds.width - bounds.padding - trigger.right - bounds.offset;
}

function alignedStart(align: TooltipAlign, start: number, length: number, size: number): number {
  if (align === "start") return start;
  if (align === "end") return start + length - size;
  return start + length / 2 - size / 2;
}

/**
 * Places a `width` × `height` tooltip on `side` of `trigger`, aligned by `align`. When that side has no
 * room it flips to the opposite side, then to the cross sides, and else takes the side with the most room;
 * the result is then shifted so the whole tooltip stays inside the viewport and below the titlebar.
 */
export function placeTooltip(
  trigger: TooltipRect,
  size: { width: number; height: number },
  side: TooltipSide,
  align: TooltipAlign,
  bounds: TooltipBounds,
): TooltipPlacement {
  const need = (candidate: TooltipSide) => (isVertical(candidate) ? size.height : size.width);
  const order = [side, OPPOSITE[side], ...CROSS[side]];
  const resolved = order.find((candidate) => room(candidate, trigger, bounds) >= need(candidate))
    ?? order.reduce((best, candidate) =>
      room(candidate, trigger, bounds) - need(candidate) > room(best, trigger, bounds) - need(best) ? candidate : best);
  const minLeft = bounds.padding;
  const maxLeft = bounds.width - bounds.padding - size.width;
  const minTop = bounds.safeTop;
  const maxTop = bounds.height - bounds.padding - size.height;
  if (isVertical(resolved)) {
    const top = resolved === "top" ? trigger.top - bounds.offset - size.height : trigger.bottom + bounds.offset;
    return {
      side: resolved,
      left: clamp(alignedStart(align, trigger.left, trigger.width, size.width), minLeft, maxLeft),
      top: clamp(top, minTop, maxTop),
    };
  }
  const left = resolved === "left" ? trigger.left - bounds.offset - size.width : trigger.right + bounds.offset;
  return {
    side: resolved,
    left: clamp(left, minLeft, maxLeft),
    top: clamp(alignedStart(align, trigger.top, trigger.height, size.height), minTop, maxTop),
  };
}

/** True when scrolling ancestors (or the viewport) clip the trigger out of sight entirely. */
export function isTriggerClipped(trigger: Element): boolean {
  const rect = trigger.getBoundingClientRect();
  let top = rect.top;
  let bottom = rect.bottom;
  let left = rect.left;
  let right = rect.right;
  for (let node = trigger.parentElement; node && node !== document.body; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    if (style.overflowX === "visible" && style.overflowY === "visible") continue;
    const box = node.getBoundingClientRect();
    top = Math.max(top, box.top);
    bottom = Math.min(bottom, box.bottom);
    left = Math.max(left, box.left);
    right = Math.min(right, box.right);
  }
  top = Math.max(top, 0);
  left = Math.max(left, 0);
  bottom = Math.min(bottom, window.innerHeight);
  right = Math.min(right, window.innerWidth);
  return bottom <= top || right <= left;
}

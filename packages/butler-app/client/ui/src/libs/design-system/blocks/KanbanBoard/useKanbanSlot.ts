import { useLayoutEffect, useRef, type RefObject } from "react";
import { animateMotion } from "../../lib/motion";

type SlotEdge = "marginBlockStart" | "marginBlockEnd";

/**
 * Opens a slot of `slot` px at a drop anchor (M5 drag feedback): a margin before or after the
 * element that grows on --motion-base while the dragged card hovers there and closes again when it
 * moves on. Lanes grow with the slot, so nothing paints past them. A drop closes it at once (the
 * cards' FLIP takes over); a slot of 0 (reduced motion, grid lanes) leaves only the line.
 */
export function useKanbanSlot(ref: RefObject<HTMLElement | null>, side: "before" | "after" | null, slot: number, dragging: boolean) {
  const open = useRef<{ edge: SlotEdge; px: number; animation: Animation | null } | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const edge: SlotEdge = side === "after" ? "marginBlockEnd" : "marginBlockStart";
    const current = open.current;
    if (current && side && slot > 0 && current.edge === edge && current.px === slot) return;
    current?.animation?.cancel();
    open.current = null;
    if (current && dragging) {
      animateMotion(element, [{ [current.edge]: `${current.px}px` }, { [current.edge]: "0px" }], { duration: "base", easing: "standard" });
    }
    if (!side || slot <= 0) return;
    const animation = animateMotion(element, [{ [edge]: "0px" }, { [edge]: `${slot}px` }], { duration: "base", easing: "standard", fill: "forwards" });
    open.current = { edge, px: slot, animation };
  }, [ref, side, slot, dragging]);
  useLayoutEffect(() => () => open.current?.animation?.cancel(), []);
}
